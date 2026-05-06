import { Router } from "express";
import { z } from "zod";
import { NotificationCategory, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { notifySocietyRoles } from "../../services/notification.service";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

// Validation schema
const toggleWaterSupplySchema = z.object({
  gateId: z.string(),
  turnedOn: z.boolean(),
  reason: z.string().optional(),
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
      roles: [UserRole.RESIDENT],
      category: NotificationCategory.WATER_SUPPLY,
      title: turnedOn ? "Water supply ON" : "Water supply OFF",
      body:
        reason ??
        (turnedOn
          ? `Water supply is ON at ${event.gate?.name ?? "the gate"}.`
          : `Water supply is OFF at ${event.gate?.name ?? "the gate"}.`),
      data: { eventId: event.id, gateId, turnedOn: String(turnedOn) },
    }).catch((err) => console.error("[notifications] water supply push failed:", err));

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

    const where: any = { societyId };
    if (gateId) where.gateId = gateId;

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
      take: limit ? parseInt(limit as string) : 50,
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
          location: gate.location,
          status: latestEvent?.turnedOn ? "ON" : "OFF",
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

    const where: any = { societyId };
    if (gateId) where.gateId = gateId;

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate as string);
      if (endDate) where.createdAt.lte = new Date(endDate as string);
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
    const groupedByDate = events.reduce((acc: any, event) => {
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

export default router;
