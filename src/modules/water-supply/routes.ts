import { Router } from "express";
import { z } from "zod";
import { NotificationCategory, Prisma } from "@prisma/client";
import { RESIDENT_LIKE_ROLES } from "../../lib/residentLike";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { isWaterTurnedOn } from "../../lib/waterEventAction";
import { notifySocietyRoles, notifyUser } from "../../services/notification.service";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

// Validation schema
const toggleWaterSupplySchema = z.object({
  gateId: z.string(),
  turnedOn: z.boolean(),
  reason: z.string().trim().optional(),
});

// POST /api/water-supply/toggle - Turn water ON/OFF (guards only)
router.post("/toggle", requireAuth, requireRole("GUARD", "ADMIN"), validateBody(toggleWaterSupplySchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { gateId, turnedOn, reason } = req.body;

    // Verify gate belongs to society
    const gate = await prisma.gate.findFirst({
      where: { id: gateId, societyId },
    });

    if (!gate) {
      return res.status(404).json({ message: "Gate not found" });
    }

    // Create water supply event
    const event = await prisma.waterSupplyEvent.create({
      data: {
        societyId,
        gateId,
        guardId: userId,
        action: turnedOn ? "TURNED_ON" : "TURNED_OFF",
        turnedOn,
        reason,
      },
      include: {
        gate: {
          select: {
            name: true,
            location: true,
          },
        },
      },
    });

    void notifySocietyRoles({
      societyId,
      roles: RESIDENT_LIKE_ROLES,
      category: NotificationCategory.WATER_SUPPLY,
      title: turnedOn ? "Water supply ON" : "Water supply OFF",
      body:
        reason ??
        (turnedOn
          ? `Water supply is ON at ${event.gate?.name ?? "the gate"}.`
          : `Water supply is OFF at ${event.gate?.name ?? "the gate"}.`),
      data: { eventId: event.id, gateId, turnedOn: String(turnedOn) },
    }).catch((err) => logger.error({ err }, "[notifications] water supply push failed"));

    return res.status(201).json({
      event,
      message: `Water supply ${turnedOn ? "turned ON" : "turned OFF"}. Residents have been notified.`,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/water-supply/events - List all water supply events
router.get("/events", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { gateId, limit } = req.query;
    const gateIdParam = typeof gateId === "string" ? gateId : undefined;

    const where: Prisma.WaterSupplyEventWhereInput = { societyId };
    if (gateIdParam) where.gateId = gateIdParam;

    const events = await prisma.waterSupplyEvent.findMany({
      where,
      include: {
        gate: {
          select: {
            name: true,
            location: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(parseInt(limit as string) || 50, 1), 200),
    });

    return res.json({ events });
  } catch (error) {
    next(error);
  }
});

// GET /api/water-supply/status - Get current water supply status
router.get("/status", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    // Get latest event for each gate
    const gates = await prisma.gate.findMany({
      where: { societyId, isActive: true },
      select: {
        id: true,
        name: true,
        location: true,
      },
    });

    const statusByGate = await Promise.all(
      gates.map(async (gate) => {
        const latestEvent = await prisma.waterSupplyEvent.findFirst({
          where: { gateId: gate.id },
          orderBy: { createdAt: "desc" },
        });

        return {
          gateId: gate.id,
          gate: gate.name,
          gateName: gate.name,
          location: gate.location,
          status: latestEvent && isWaterTurnedOn(latestEvent) ? "ON" : "OFF",
          lastChanged: latestEvent?.createdAt,
          reason: latestEvent?.reason,
        };
      })
    );

    return res.json({ status: statusByGate });
  } catch (error) {
    next(error);
  }
});

// GET /api/water-supply/history - Historical logs with date filter
router.get("/history", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { startDate, endDate, gateId } = req.query;
    const gateIdParam = typeof gateId === "string" ? gateId : undefined;

    const where: Prisma.WaterSupplyEventWhereInput = { societyId };
    if (gateIdParam) where.gateId = gateIdParam;

    if (startDate || endDate) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (startDate) createdAt.gte = new Date(startDate as string);
      if (endDate) createdAt.lte = new Date(endDate as string);
      where.createdAt = createdAt;
    }

    const events = await prisma.waterSupplyEvent.findMany({
      where,
      include: {
        gate: {
          select: {
            name: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Group by date
    const groupedByDate = events.reduce<Record<string, typeof events>>((acc, event) => {
      const date = event.createdAt.toISOString().split("T")[0];
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(event);
      return acc;
    }, {});

    return res.json({ history: groupedByDate });
  } catch (error) {
    next(error);
  }
});

// ── Water Supply Requests (guard/admin resolution) ────────────────────────

// GET /api/water-supply/requests/pending - List pending requests for the society
router.get("/requests/pending", requireAuth, requireRole("GUARD", "ADMIN"), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const requests = await prisma.waterSupplyRequest.findMany({
      where: { societyId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: {
        gate: { select: { name: true } },
        user: { select: { name: true } },
      },
    });
    return res.json({ requests });
  } catch (error) {
    next(error);
  }
});

const resolveRequestSchema = z.object({
  status: z.enum(["FULFILLED", "REJECTED"]),
  note: z.string().trim().max(200).optional(),
});

// PATCH /api/water-supply/requests/:id/resolve - Resolve a water supply request
router.patch("/requests/:id/resolve", requireAuth, requireRole("GUARD", "ADMIN"), validateBody(resolveRequestSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;
    const { status, note } = req.body as z.infer<typeof resolveRequestSchema>;

    const request = await prisma.waterSupplyRequest.findFirst({
      where: { id, societyId, status: "PENDING" },
      include: { gate: { select: { name: true } } },
    });
    if (!request) {
      return res.status(404).json({ message: "Request not found or already resolved" });
    }

    const updated = await prisma.waterSupplyRequest.update({
      where: { id },
      data: {
        status,
        resolvedById: userId,
        resolvedAt: new Date(),
        resolvedNote: note,
      },
      include: {
        gate: { select: { name: true } },
        resolvedBy: { select: { name: true } },
      },
    });

    // Notify the requesting resident
    void notifyUser(
      request.userId,
      {
        title: status === "FULFILLED"
          ? "Water request fulfilled"
          : "Water request declined",
        body: status === "FULFILLED"
          ? `Your water ${request.requestType === "TURN_ON" ? "ON" : "OFF"} request at ${request.gate.name} has been fulfilled.`
          : `Your water request at ${request.gate.name} was declined.${note ? ` Note: ${note}` : ""}`,
        data: {
          type: "WATER_SUPPLY_REQUEST_RESOLVED",
          requestId: id,
          status,
        },
      },
      { category: NotificationCategory.WATER_SUPPLY },
    ).catch((err) => logger.error({ err }, "[notifications] water request resolve push failed"));

    return res.json({
      message: `Request ${status.toLowerCase()}`,
      request: updated,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
