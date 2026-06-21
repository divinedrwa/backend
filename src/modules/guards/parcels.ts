import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { NotificationCategory, UserRole, ParcelStatus } from "@prisma/client";
import { notifyUsers } from "../../services/notification.service";
import { resolveGuardLogRange } from "./guardLogRange";
import { residentLikeRoleFilter } from "../../lib/residentLike";

const router = Router();

router.use(requireAuth);

/** Prisma `Parcel.description` is required — guards often omit notes. */
export function normalizeParcelDescription(description?: string | null): string {
  return description?.trim() ?? "";
}

// Validation schema
const logParcelSchema = z.object({
  villaId: z.string(),
  deliveryService: z.string().trim().optional(),
  trackingNumber: z.string().trim().optional(),
  senderName: z.string().trim().optional(),
  description: z.string().trim().optional(),
  photoUrl: z.string().url().optional(),
});

// POST /api/guards/parcel-received - Log parcel
router.post("/parcel-received", requireRole(UserRole.GUARD), validateBody(logParcelSchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { villaId, deliveryService, trackingNumber, senderName, description, photoUrl } = req.body;

    // Verify villa exists
    const villa = await prisma.villa.findFirst({
      where: { id: villaId, societyId },
    });

    if (!villa) {
      return res.status(404).json({ message: "Villa not found" });
    }

    const parcel = await prisma.parcel.create({
      data: {
        societyId,
        villaId,
        deliveryService,
        trackingNumber,
        senderName,
        description: normalizeParcelDescription(description),
        photoUrl,
        receivedAt: new Date(),
        status: ParcelStatus.RECEIVED, // Use enum
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
          },
        },
      },
    });

    // Notify villa residents about new parcel
    void (async () => {
      try {
        const residents = await prisma.user.findMany({
          where: {
            villaId,
            societyId,
            ...residentLikeRoleFilter,
            isActive: true,
          },
          select: { id: true },
        });
        if (residents.length > 0) {
          await notifyUsers(
            residents.map((r) => r.id),
            {
              title: "New parcel received",
              body: `A parcel has been received for villa ${villa.villaNumber}.${description ? ` (${description})` : ""}`,
              data: { type: "PARCEL_RECEIVED", parcelId: parcel.id, villaId },
            },
            { category: NotificationCategory.SYSTEM },
          );
        }
      } catch {
        // Fire-and-forget — don't fail the main request
      }
    })();

    return res.status(201).json({
      message: "Parcel logged successfully",
      parcel,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/guards/parcels-pending - Get uncollected parcels
router.get("/parcels-pending", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const pendingParcels = await prisma.parcel.findMany({
      where: {
        societyId,
        status: ParcelStatus.RECEIVED, // Use enum
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
          },
        },
      },
      orderBy: { receivedAt: "asc" }, // Oldest first
    });

    return res.json({
      parcels: pendingParcels,
      count: pendingParcels.length,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/guards/parcels/:id/delivered - Mark as delivered
router.patch("/parcels/:id/delivered", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;
    const { notes } = req.body;

    const parcel = await prisma.parcel.findFirst({
      where: { id, societyId },
    });

    if (!parcel) {
      return res.status(404).json({ message: "Parcel not found" });
    }

    if (parcel.status === ParcelStatus.COLLECTED) {
      return res.status(400).json({ message: "Parcel already collected" });
    }

    const updated = await prisma.parcel.update({
      where: { id },
      data: {
        status: ParcelStatus.COLLECTED, // Mark as collected by resident
        collectedAt: new Date(),
        ...(notes && { description: `${parcel.description || ""}\n[Delivery Notes: ${notes}]` }),
      },
    });

    return res.json({
      message: "Parcel marked as delivered",
      parcel: updated,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/guards/parcels-today - Today's parcels
// GET /api/guards/my-parcels - Alias for mobile app
router.get(["/parcels-today", "/my-parcels"], requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const range = resolveGuardLogRange(req.query as Record<string, unknown>);
    if (!range.ok) {
      return res.status(400).json({ message: range.message });
    }

    const parcels = await prisma.parcel.findMany({
      where: {
        societyId,
        receivedAt: { gte: range.start, lte: range.endInclusive },
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
          },
        },
      },
      orderBy: { receivedAt: "desc" },
    });

    const collected = parcels.filter((p) => p.status === ParcelStatus.COLLECTED);
    const pending = parcels.filter((p) => p.status === ParcelStatus.RECEIVED);

    return res.json({
      parcels,
      summary: {
        total: parcels.length,
        collected: collected.length,
        pending: pending.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
