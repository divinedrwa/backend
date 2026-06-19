import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { UserRole, GateVehicleKind, SocBroadcastKind, IncidentSeverity, NotificationCategory } from "@prisma/client";
import { resolveGuardLogRange } from "./guardLogRange";
import { residentLikeRoleFilter } from "../../lib/residentLike";

const router = Router();
router.use(requireAuth);

function maskPhone(phone: string | null | undefined): string | null {
  if (!phone || phone.replace(/\D/g, "").length < 4) return null;
  const digits = phone.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  return `****${last4}`;
}

const vehicleEntrySchema = z.object({
  registrationNumber: z.string().trim().min(3).max(32),
  kind: z.enum(["RESIDENT", "VISITOR"]),
  villaId: z.string().optional(),
  notes: z.string().trim().optional(),
});

const socSchema = z.object({
  kind: z.enum(["FIRE", "MEDICAL", "SECURITY"]),
  note: z.string().trim().optional(),
});

// POST /api/guards/gate-vehicle/entry
router.post("/gate-vehicle/entry", requireRole(UserRole.GUARD), validateBody(vehicleEntrySchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { registrationNumber, kind, villaId, notes } = req.body;

    if (villaId) {
      const villa = await prisma.villa.findFirst({ where: { id: villaId, societyId } });
      if (!villa) return res.status(400).json({ message: "Invalid villa" });
    }

    const row = await prisma.gateVehicleLedger.create({
      data: {
        societyId,
        guardId: userId,
        registrationNumber: registrationNumber.trim().toUpperCase(),
        kind: kind as GateVehicleKind,
        villaId: villaId || null,
        notes: notes?.trim() || null,
      },
      include: {
        villa: { select: { id: true, villaNumber: true, block: true } },
      },
    });

    return res.status(201).json({ message: "Vehicle entry logged", entry: row });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/guards/gate-vehicle/:id/exit
router.patch("/gate-vehicle/:id/exit", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    const existing = await prisma.gateVehicleLedger.findFirst({
      where: { id, societyId },
    });
    if (!existing) return res.status(404).json({ message: "Entry not found" });
    if (existing.exitAt) return res.status(400).json({ message: "Already exited" });

    const updated = await prisma.gateVehicleLedger.update({
      where: { id },
      data: { exitAt: new Date() },
    });
    return res.json({ message: "Exit recorded", entry: updated });
  } catch (error) {
    next(error);
  }
});

// GET /api/guards/gate-vehicle/today
router.get("/gate-vehicle/today", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const range = resolveGuardLogRange(req.query as Record<string, unknown>);
    if (!range.ok) {
      return res.status(400).json({ message: range.message });
    }

    const entries = await prisma.gateVehicleLedger.findMany({
      where: {
        societyId,
        entryAt: { gte: range.start, lte: range.endInclusive },
      },
      orderBy: { entryAt: "desc" },
      include: {
        villa: { select: { villaNumber: true, block: true } },
        guard: { select: { name: true } },
      },
    });

    return res.json({ entries, count: entries.length });
  } catch (error) {
    next(error);
  }
});

// POST /api/guards/soc-broadcast — audit + in-app notifications to admins
router.post("/soc-broadcast", requireRole(UserRole.GUARD), validateBody(socSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { kind, note } = req.body;

    const broadcast = await prisma.socBroadcast.create({
      data: {
        societyId,
        guardId: userId,
        kind: kind as SocBroadcastKind,
        note: note?.trim() || null,
      },
    });

    const admins = await prisma.user.findMany({
      where: { societyId, role: { in: [UserRole.ADMIN, UserRole.RESIDENT_CUM_ADMIN] }, isActive: true },
      select: { id: true },
    });

    if (admins.length > 0) {
      await prisma.userNotification.createMany({
        data: admins.map((a) => ({
          societyId,
          userId: a.id,
          category: NotificationCategory.SOS,
          title: `SOC ${kind}`,
          body: note?.trim() || `Gate escalation (${kind})`,
          data: { broadcastId: broadcast.id, guardId: userId },
        })),
      });
    }

    return res.status(201).json({
      message: "SOC broadcast recorded",
      broadcast,
      notifiedAdmins: admins.length,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/guards/residents-directory
router.get("/residents-directory", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const q = ((req.query.q as string) || "").trim().toLowerCase();

    const residents = await prisma.user.findMany({
      where: {
        societyId,
        // Villa occupants who can receive a visitor at their flat. Uses the same
        // role set as the visitor-approval recipient resolver and occupant
        // notifications (residentLikeRoleFilter = RESIDENT, ADMIN, RESIDENT_CUM_ADMIN)
        // so a resident who is also an admin (role ADMIN, villa mapped) still shows
        // up here and isn't wrongly flagged "no resident mapped to selected flat".
        ...residentLikeRoleFilter,
        isActive: true,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { villa: { villaNumber: { contains: q, mode: "insensitive" } } },
                { villa: { block: { contains: q, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      take: 80,
      select: {
        id: true,
        name: true,
        phone: true,
        villa: {
          select: {
            id: true,
            villaNumber: true,
            block: true,
          },
        },
      },
    });

    // Guard-authenticated: include raw phone for gate dialer (same policy as in-person directory).
    const rows = residents.map((r) => {
      const block = r.villa?.block;
      const num = r.villa?.villaNumber ?? "";
      const flatLabel =
        block && block.length > 0 ? `${block}-${num}` : num;
      return {
        userId: r.id,
        name: r.name,
        phone: r.phone,
        phoneMasked: maskPhone(r.phone),
        villaId: r.villa?.id ?? null,
        flatLabel,
      };
    });

    return res.json({ residents: rows, count: rows.length });
  } catch (error) {
    next(error);
  }
});

// POST /api/guards/incidents — validated guard incident API
const incidentGuardSchema = z.object({
  title: z.string().trim().min(3),
  description: z.string().trim().min(3),
  location: z.string().trim().optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
});

router.post("/incidents", requireRole(UserRole.GUARD), validateBody(incidentGuardSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { title, description, location, severity } = req.body;

    const incident = await prisma.incident.create({
      data: {
        societyId,
        reportedBy: userId,
        title,
        description,
        location: location ?? null,
        severity: (severity as IncidentSeverity) ?? IncidentSeverity.MEDIUM,
      },
    });

    return res.status(201).json({ message: "Incident logged", incident });
  } catch (error) {
    next(error);
  }
});

export default router;
