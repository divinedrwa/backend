import { Router } from "express";
import { z } from "zod";
import { NotificationCategory, Prisma, UserRole } from "@prisma/client";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { notifySocietyRoles } from "../../services/notification.service";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

// Validation schemas
const logEntrySchema = z.object({
  gateId: z.string(),
  notes: z.string().trim().optional(),
});

// POST /api/garbage-collection/entry - Log garbage collector entry (guards only)
router.post("/entry", requireAuth, requireRole("GUARD", "ADMIN"), validateBody(logEntrySchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { gateId, notes } = req.body;

    // Verify gate belongs to society
    const gate = await prisma.gate.findFirst({
      where: { id: gateId, societyId },
    });

    if (!gate) {
      return res.status(404).json({ message: "Gate not found" });
    }

    // Create garbage collection event
    const event = await prisma.garbageCollectionEvent.create({
      data: {
        societyId,
        gateId,
        guardId: userId,
        entryTime: new Date(),
        notes,
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
      category: NotificationCategory.GARBAGE,
      title: "Garbage collection",
      body: `Collector arrived at ${event.gate?.name ?? "the gate"}. Please prepare your garbage.`,
      data: { eventId: event.id, gateId },
    }).catch((err) => logger.error({ err }, "[notifications] garbage push failed"));

    return res.status(201).json({
      event,
      message: "Garbage collector entry logged. All residents have been notified.",
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/garbage-collection/:id/exit - Log garbage collector exit (guards only)
router.patch("/:id/exit", requireAuth, requireRole("GUARD", "ADMIN"), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;
    const { notes } = req.body;

    const event = await prisma.garbageCollectionEvent.findFirst({
      where: { id, societyId },
    });

    if (!event) {
      return res.status(404).json({ message: "Garbage collection event not found" });
    }

    if (event.exitTime) {
      return res.status(400).json({
        message: "Exit time already recorded for this event",
      });
    }

    const updatedEvent = await prisma.garbageCollectionEvent.update({
      where: { id },
      data: {
        exitTime: new Date(),
        notes: notes || event.notes,
      },
      include: {
        gate: {
          select: {
            name: true,
          },
        },
      },
    });

    return res.json({
      event: updatedEvent,
      message: "Garbage collector exit logged",
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/garbage-collection/events - List all garbage collection events
router.get("/events", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { gateId, limit } = req.query;
    const gateIdParam = typeof gateId === "string" ? gateId : undefined;

    const where: Prisma.GarbageCollectionEventWhereInput = { societyId };
    if (gateIdParam) where.gateId = gateIdParam;

    const events = await prisma.garbageCollectionEvent.findMany({
      where,
      include: {
        gate: {
          select: {
            name: true,
            location: true,
          },
        },
      },
      orderBy: { entryTime: "desc" },
      take: limit ? parseInt(limit as string) : 50,
    });

    return res.json({ events });
  } catch (error) {
    next(error);
  }
});

// GET /api/garbage-collection/active - Check if garbage collector is currently inside
router.get("/active", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const activeEvent = await prisma.garbageCollectionEvent.findFirst({
      where: {
        societyId,
        exitTime: null,
      },
      include: {
        gate: {
          select: {
            name: true,
            location: true,
          },
        },
      },
      orderBy: { entryTime: "desc" },
    });

    return res.json({
      isInside: !!activeEvent,
      event: activeEvent,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/garbage-collection/history - Historical logs with date filter
router.get("/history", requireAuth, async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { startDate, endDate, gateId } = req.query;
    const gateIdParam = typeof gateId === "string" ? gateId : undefined;

    const where: Prisma.GarbageCollectionEventWhereInput = { societyId };
    if (gateIdParam) where.gateId = gateIdParam;

    if (startDate || endDate) {
      const entryTime: Prisma.DateTimeFilter = {};
      if (startDate) entryTime.gte = new Date(startDate as string);
      if (endDate) entryTime.lte = new Date(endDate as string);
      where.entryTime = entryTime;
    }

    const events = await prisma.garbageCollectionEvent.findMany({
      where,
      include: {
        gate: {
          select: {
            name: true,
          },
        },
      },
      orderBy: { entryTime: "desc" },
    });

    // Calculate average duration
    const completedEvents = events.filter(e => e.exitTime);
    const avgDuration = completedEvents.length > 0
      ? Math.floor(
          completedEvents.reduce((sum, e) => {
            const duration = e.exitTime!.getTime() - e.entryTime.getTime();
            return sum + duration;
          }, 0) / completedEvents.length / 60000
        )
      : 0;

    return res.json({
      events,
      stats: {
        totalEvents: events.length,
        completedEvents: completedEvents.length,
        avgDurationMinutes: avgDuration,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
