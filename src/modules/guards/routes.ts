import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { Gate, GuardShift, UserRole, SOSStatus } from "@prisma/client";
import { findActiveGuardShift } from "../../lib/guardShiftActive";

type GuardShiftWithGate = GuardShift & { gate: Gate };
import {
  clearSosEscalation,
  notifyResidentSosUpdate,
} from "../../services/sosLifecycle.service";

const router = Router();

const GUARD_OPEN_SOS: SOSStatus[] = [
  SOSStatus.CREATED,
  SOSStatus.ACTIVE,
  SOSStatus.PENDING,
  SOSStatus.ACKNOWLEDGED,
  SOSStatus.IN_PROGRESS,
];

router.use(requireAuth);

// GET /api/guards/my-dashboard - Get guard dashboard
router.get("/my-dashboard", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    // Get guard info and assigned gate
    const guard = await prisma.user.findFirst({
      where: { id: userId, societyId, role: UserRole.GUARD },
      select: {
        id: true,
        name: true,
        phone: true,
      },
    });

    if (!guard) {
      return res.status(404).json({ message: "Guard not found" });
    }

    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const currentShift = await findActiveGuardShift(prisma, {
      guardId: userId,
      societyId,
      now,
      include: {
        gate: {
          select: {
            id: true,
            name: true,
            location: true,
          },
        },
      },
    });

    // Get today's statistics (reuse today/tomorrow from above)
    const [visitorsToday, parcelsToday, incidentsToday, patrolsToday] = await Promise.all([
      prisma.visitor.count({
        where: {
          societyId,
          checkInTime: { gte: today, lt: tomorrow },
        },
      }),
      prisma.parcel.count({
        where: {
          societyId,
          receivedAt: { gte: today, lt: tomorrow },
        },
      }),
      prisma.incident.count({
        where: {
          societyId,
          createdAt: { gte: today, lt: tomorrow },
        },
      }),
      prisma.guardPatrol.count({
        where: {
          guardId: userId,
          scheduledTime: { gte: today, lt: tomorrow },
        },
      }),
    ]);

    // Get active SOS alerts
    const activeSOS = await prisma.sOSAlert.findMany({
      where: {
        societyId,
        status: { in: GUARD_OPEN_SOS },
      },
      include: {
        user: { // Correct relation name
          select: {
            name: true,
            phone: true,
          },
        },
        villa: {
          select: {
            villaNumber: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    return res.json({
      guard,
      currentShift,
      todayStats: {
        visitors: visitorsToday,
        parcels: parcelsToday,
        incidents: incidentsToday,
        patrols: patrolsToday,
      },
      activeSOS,
      timestamp: new Date(),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/guards/my-gate - Get assigned gate
router.get("/my-gate", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    const now = new Date();

    const currentShift = (await findActiveGuardShift(prisma, {
      guardId: userId,
      societyId,
      now,
      include: {
        gate: true,
      },
    })) as GuardShiftWithGate | null;

    if (!currentShift?.gate) {
      return res.status(404).json({ message: "No gate assigned" });
    }

    return res.json({ gate: currentShift.gate, shift: currentShift });
  } catch (error) {
    next(error);
  }
});

// GET /api/guards/my-shifts - Get my schedule
router.get("/my-shifts", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { days = "7" } = req.query;

    const daysBack = parseInt(days as string, 10) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const shifts = await prisma.guardShift.findMany({
      where: {
        guardId: userId,
        societyId,
        OR: [{ recurringDaily: true }, { recurringDaily: false, startTime: { gte: startDate } }],
      },
      include: {
        gate: {
          select: {
            name: true,
            location: true,
          },
        },
      },
      orderBy: { startTime: "desc" },
    });

    return res.json({ shifts, count: shifts.length });
  } catch (error) {
    next(error);
  }
});

// GET /api/guards/active-alerts - Get active SOS alerts
router.get("/active-alerts", requireRole(UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const alerts = await prisma.sOSAlert.findMany({
      where: {
        societyId,
        status: { in: GUARD_OPEN_SOS },
      },
      include: {
        user: { // Correct relation name
          select: {
            name: true,
            phone: true,
          },
        },
        villa: {
          select: {
            villaNumber: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return res.json({ alerts, count: alerts.length });
  } catch (error) {
    next(error);
  }
});

const sosResponseSchema = z.object({
  alertId: z.string().min(1),
  status: z.enum(["ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED"]),
  notes: z.string().trim().optional(),
});

// POST /api/guards/sos-response — legacy mobile; prefers PATCH /sos-alerts/:id/*
router.post("/sos-response", requireRole(UserRole.GUARD), validateBody(sosResponseSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { alertId, status } = req.body as z.infer<typeof sosResponseSchema>;

    const alert = await prisma.sOSAlert.findFirst({
      where: { id: alertId, societyId },
    });

    if (!alert) {
      return res.status(404).json({ message: "Alert not found" });
    }

    const st = status as SOSStatus;

    if (st === SOSStatus.ACKNOWLEDGED) {
      const canAck =
        alert.status === SOSStatus.CREATED ||
        alert.status === SOSStatus.ACTIVE ||
        alert.status === SOSStatus.PENDING;
      if (!canAck) {
        return res.status(400).json({ message: "Cannot acknowledge in current state" });
      }
      clearSosEscalation(alertId);
      const acknowledgedAt = new Date();
      const responseTimeSec = Math.floor(
        (acknowledgedAt.getTime() - alert.createdAt.getTime()) / 1000,
      );
      const updated = await prisma.sOSAlert.update({
        where: { id: alertId },
        data: {
          status: SOSStatus.ACKNOWLEDGED,
          acknowledgedBy: userId,
          acknowledgedAt,
          responseTime: responseTimeSec,
          assignedGuardId: userId,
        },
      });
      if (alert.triggeredBy) {
        void notifyResidentSosUpdate({
          alertId,
          residentUserId: alert.triggeredBy,
          title: "Help is on the way",
          body: "A guard has acknowledged your SOS.",
          extraData: { sosStatus: SOSStatus.ACKNOWLEDGED },
        }).catch(() => undefined);
      }
      return res.json({ message: "SOS response recorded", alert: updated });
    }

    if (st === SOSStatus.IN_PROGRESS) {
      if (alert.status !== SOSStatus.ACKNOWLEDGED) {
        return res.status(400).json({ message: "Start requires ACKNOWLEDGED" });
      }
      const updated = await prisma.sOSAlert.update({
        where: { id: alertId },
        data: {
          status: SOSStatus.IN_PROGRESS,
          inProgressAt: new Date(),
          assignedGuardId: userId,
        },
      });
      if (alert.triggeredBy) {
        void notifyResidentSosUpdate({
          alertId,
          residentUserId: alert.triggeredBy,
          title: "Response in progress",
          body: "Emergency responders are attending your SOS.",
          extraData: { sosStatus: SOSStatus.IN_PROGRESS },
        }).catch(() => undefined);
      }
      return res.json({ message: "SOS response recorded", alert: updated });
    }

    if (st === SOSStatus.RESOLVED) {
      if (
        alert.status === SOSStatus.RESOLVED ||
        alert.status === SOSStatus.CANCELLED
      ) {
        return res.status(400).json({ message: "Invalid transition" });
      }
      clearSosEscalation(alertId);
      const resolvedAt = new Date();
      const updated = await prisma.sOSAlert.update({
        where: { id: alertId },
        data: {
          status: SOSStatus.RESOLVED,
          resolvedBy: userId,
          resolvedAt,
        },
      });
      if (alert.triggeredBy) {
        void notifyResidentSosUpdate({
          alertId,
          residentUserId: alert.triggeredBy,
          title: "SOS resolved",
          body: "Your emergency alert has been closed by security.",
          extraData: { sosStatus: SOSStatus.RESOLVED },
        }).catch(() => undefined);
      }
      return res.json({ message: "SOS response recorded", alert: updated });
    }

    return res.status(400).json({ message: "Unsupported SOS status for guard response" });
  } catch (error) {
    next(error);
  }
});

export default router;
