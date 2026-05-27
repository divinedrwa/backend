import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { SOSType, SOSStatus, UserRole } from "@prisma/client";
import {
  createSOSAlert,
  transitionSOSState,
  SOSTransitionType,
} from "../../services/sos-coordinator";

const router = Router();

const createSOSSchema = z.object({
  emergencyType: z.enum(["MEDICAL", "FIRE", "THEFT", "ACCIDENT", "SECURITY", "OTHER"]),
  message: z.string().optional(),
  location: z.string().optional(),
  latitude: z.number().finite().optional(),
  longitude: z.number().finite().optional(),
});

const cancelSOSSchema = z.object({
  reason: z.string().min(3).max(500),
});

const alertInclude = {
  villa: {
    select: {
      villaNumber: true,
      ownerName: true,
      block: true,
    },
  },
  user: {
    select: {
      name: true,
      phone: true,
    },
  },
  assignedGuard: {
    select: {
      id: true,
      name: true,
      phone: true,
    },
  },
} as const;

/** SOS rate limit: 5 per 15 min per IP to prevent accidental spam. */
const sosRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many SOS alerts. Please wait before sending another." },
});

// POST /api/sos-alerts - Trigger SOS (residents/admin only)
router.post("/", requireAuth, requireRole(UserRole.RESIDENT, UserRole.ADMIN), sosRateLimiter, validateBody(createSOSSchema), async (req, res, next) => {
  try {
    const { userId, societyId, villaId } = req.auth!;
    const { emergencyType, message, location, latitude, longitude } = req.body;

    if (!villaId) {
      return res.status(400).json({
        message: "Only residents with assigned villas can trigger SOS alerts",
      });
    }

    // Use centralized coordinator
    const alert = await prisma.$transaction(async (tx) => {
      return await createSOSAlert(tx, {
        societyId,
        villaId,
        triggeredBy: userId,
        emergencyType: emergencyType as SOSType,
        message,
        location,
        latitude,
        longitude,
      });
    });

    // Fetch with full includes for response
    const fullAlert = await prisma.sOSAlert.findUnique({
      where: { id: alert.id },
      include: alertInclude,
    });

    return res.status(201).json({
      alert: fullAlert,
      message: "SOS alert triggered. Guards and admin have been notified.",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "DUPLICATE_OPEN_SOS") {
      return res.status(409).json({
        message:
          "You already have an active SOS. Wait for resolution or cancel it from the app.",
      });
    }
    next(error);
  }
});

// GET /api/sos-alerts - List SOS alerts (guards/admin)
router.get("/", requireAuth, requireRole(UserRole.ADMIN, UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { status, villaId } = req.query;

    const where: Record<string, unknown> = { societyId };
    if (status && typeof status === "string" && Object.values(SOSStatus).includes(status as SOSStatus)) {
      where.status = status;
    }
    if (villaId && typeof villaId === "string") where.villaId = villaId;

    const pagination = getPagination(req);
    const [alerts, total] = await Promise.all([
      prisma.sOSAlert.findMany({
        where,
        include: alertInclude,
        orderBy: { createdAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.sOSAlert.count({ where }),
    ]);

    return res.json({
      alerts,
      ...paginationMeta(total, alerts.length, pagination),
    });
  } catch (error) {
    next(error);
  }
});

const ACTIVE_FILTER = {
  in: [
    SOSStatus.CREATED,
    SOSStatus.ACTIVE,
    SOSStatus.PENDING,
    SOSStatus.ACKNOWLEDGED,
    SOSStatus.IN_PROGRESS,
  ],
};

// GET /api/sos-alerts/active - Active alerts only
router.get("/active", requireAuth, requireRole(UserRole.ADMIN, UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    // Active alerts under normal operation is a small set, but cap the
    // result so a stuck/never-resolved batch can't return an unbounded
    // payload to the on-call dashboard.
    const activeAlerts = await prisma.sOSAlert.findMany({
      where: {
        societyId,
        status: ACTIVE_FILTER,
      },
      include: alertInclude,
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return res.json({ alerts: activeAlerts });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/sos-alerts/:id/acknowledge
router.patch(
  "/:id/acknowledge",
  requireAuth,
  requireRole(UserRole.ADMIN, UserRole.GUARD),
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;
      const { id } = req.params;

      const alert = await prisma.sOSAlert.findFirst({
        where: { id, societyId },
      });

      if (!alert) {
        return res.status(404).json({ message: "SOS alert not found" });
      }

      const canAck =
        alert.status === SOSStatus.CREATED ||
        alert.status === SOSStatus.ACTIVE ||
        alert.status === SOSStatus.PENDING;

      if (!canAck) {
        return res.status(400).json({
          message: "Alert cannot be acknowledged in its current state",
        });
      }

      // Use centralized coordinator
      await prisma.$transaction(async (tx) => {
        await transitionSOSState(tx, {
          alertId: id,
          fromStatus: alert.status,
          toStatus: SOSStatus.ACKNOWLEDGED,
          transitionType: SOSTransitionType.ACKNOWLEDGE,
          actorUserId: userId,
          societyId,
          timestamp: new Date(),
        });
      });

      const updatedAlert = await prisma.sOSAlert.findUnique({
        where: { id },
        include: alertInclude,
      });

      return res.json({
        alert: updatedAlert,
        message: "SOS alert acknowledged",
      });
    } catch (error) {
      next(error);
    }
  },
);

// PATCH /api/sos-alerts/:id/start — IN_PROGRESS (usually guard on scene)
router.patch(
  "/:id/start",
  requireAuth,
  requireRole(UserRole.ADMIN, UserRole.GUARD),
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;
      const { id } = req.params;

      const alert = await prisma.sOSAlert.findFirst({
        where: { id, societyId },
      });

      if (!alert) {
        return res.status(404).json({ message: "SOS alert not found" });
      }

      if (alert.status !== SOSStatus.ACKNOWLEDGED) {
        return res.status(400).json({
          message: "Start requires ACKNOWLEDGED status",
        });
      }

      // Use centralized coordinator
      await prisma.$transaction(async (tx) => {
        await transitionSOSState(tx, {
          alertId: id,
          fromStatus: alert.status,
          toStatus: SOSStatus.IN_PROGRESS,
          transitionType: SOSTransitionType.START_RESPONSE,
          actorUserId: userId,
          societyId,
          timestamp: new Date(),
        });
      });

      const updatedAlert = await prisma.sOSAlert.findUnique({
        where: { id },
        include: alertInclude,
      });

      return res.json({
        alert: updatedAlert,
        message: "SOS marked in progress",
      });
    } catch (error) {
      next(error);
    }
  },
);

// PATCH /api/sos-alerts/:id/resolve
router.patch(
  "/:id/resolve",
  requireAuth,
  requireRole(UserRole.ADMIN, UserRole.GUARD),
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;
      const { id } = req.params;

      const alert = await prisma.sOSAlert.findFirst({
        where: { id, societyId },
      });

      if (!alert) {
        return res.status(404).json({ message: "SOS alert not found" });
      }

      if (alert.status === SOSStatus.RESOLVED) {
        return res.status(400).json({
          message: "Alert is already resolved",
        });
      }

      if (alert.status === SOSStatus.CANCELLED) {
        return res.status(400).json({ message: "Cancelled SOS cannot be resolved" });
      }

      // Use centralized coordinator
      await prisma.$transaction(async (tx) => {
        await transitionSOSState(tx, {
          alertId: id,
          fromStatus: alert.status,
          toStatus: SOSStatus.RESOLVED,
          transitionType: SOSTransitionType.RESOLVE,
          actorUserId: userId,
          societyId,
          timestamp: new Date(),
        });
      });

      const updatedAlert = await prisma.sOSAlert.findUnique({
        where: { id },
        include: alertInclude,
      });

      return res.json({
        alert: updatedAlert,
        message: "SOS alert resolved",
      });
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/sos-alerts/:id/cancel — Resident only
router.post(
  "/:id/cancel",
  requireAuth,
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  validateBody(cancelSOSSchema),
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;
      const { id } = req.params;
      const { reason } = req.body as z.infer<typeof cancelSOSSchema>;

      const alert = await prisma.sOSAlert.findFirst({
        where: { id, societyId, triggeredBy: userId },
      });

      if (!alert) {
        return res.status(404).json({ message: "SOS alert not found" });
      }

      const cancellable =
        alert.status === SOSStatus.CREATED ||
        alert.status === SOSStatus.ACTIVE ||
        alert.status === SOSStatus.PENDING ||
        alert.status === SOSStatus.ACKNOWLEDGED ||
        alert.status === SOSStatus.IN_PROGRESS;

      if (!cancellable) {
        return res.status(400).json({ message: "This SOS cannot be cancelled" });
      }

      // Use centralized coordinator
      await prisma.$transaction(async (tx) => {
        await transitionSOSState(tx, {
          alertId: id,
          fromStatus: alert.status,
          toStatus: SOSStatus.CANCELLED,
          transitionType: SOSTransitionType.CANCEL,
          actorUserId: userId,
          societyId,
          timestamp: new Date(),
          metadata: { cancelReason: reason },
        });
      });

      const updated = await prisma.sOSAlert.findUnique({
        where: { id },
        include: alertInclude,
      });

      return res.json({ alert: updated, message: "SOS cancelled" });
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/sos-alerts/stats
router.get("/stats", requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const totalAlerts = await prisma.sOSAlert.count({
      where: { societyId },
    });

    const activeAlerts = await prisma.sOSAlert.count({
      where: { societyId, status: ACTIVE_FILTER },
    });

    const resolvedAlerts = await prisma.sOSAlert.count({
      where: { societyId, status: SOSStatus.RESOLVED },
    });

    const resolvedList = await prisma.sOSAlert.findMany({
      where: {
        societyId,
        status: SOSStatus.RESOLVED,
        acknowledgedAt: { not: null },
      },
      select: {
        responseTime: true,
        resolvedAt: true,
        acknowledgedAt: true,
        createdAt: true,
      },
    });

    let avgAckSeconds = 0;
    let avgResolutionSeconds = 0;
    if (resolvedList.length > 0) {
      const ackSum = resolvedList.reduce((s, a) => {
        if (!a.acknowledgedAt) return s;
        return s + Math.floor((a.acknowledgedAt.getTime() - a.createdAt.getTime()) / 1000);
      }, 0);
      const ackCount = resolvedList.filter((a) => a.acknowledgedAt).length;
      avgAckSeconds = ackCount ? Math.floor(ackSum / ackCount) : 0;

      const resSum = resolvedList.reduce((s, a) => {
        if (!a.resolvedAt) return s;
        return s + Math.floor((a.resolvedAt.getTime() - a.createdAt.getTime()) / 1000);
      }, 0);
      avgResolutionSeconds = Math.floor(resSum / resolvedList.length);
    }

    const typeDistribution = await prisma.sOSAlert.groupBy({
      by: ["emergencyType"],
      where: { societyId },
      _count: true,
    });

    return res.json({
      totalAlerts,
      activeAlerts,
      resolvedAlerts,
      avgAcknowledgementSeconds: avgAckSeconds,
      avgResolutionSeconds,
      avgResponseTimeSeconds: avgAckSeconds,
      typeDistribution,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
