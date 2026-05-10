import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { NotificationCategory, SOSType, SOSStatus, UserRole } from "@prisma/client";
import { notifySocietyRoles } from "../../services/notification.service";
import {
  OPEN_SOS_STATUSES,
  scheduleSosEscalation,
  clearSosEscalation,
  notifyResidentSosUpdate,
} from "../../services/sosLifecycle.service";

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

function villaLabelFromAlert(a: {
  villa: { villaNumber: string; block: string | null };
}): string {
  return a.villa.block
    ? `${a.villa.block} · ${a.villa.villaNumber}`
    : a.villa.villaNumber;
}

// POST /api/sos-alerts - Trigger SOS (residents)
router.post("/", requireAuth, validateBody(createSOSSchema), async (req, res, next) => {
  try {
    const { userId, societyId, villaId } = req.auth!;
    const { emergencyType, message, location, latitude, longitude } = req.body;

    if (!villaId) {
      return res.status(400).json({
        message: "Only residents with assigned villas can trigger SOS alerts",
      });
    }

    const duplicate = await prisma.sOSAlert.findFirst({
      where: {
        triggeredBy: userId,
        societyId,
        status: { in: OPEN_SOS_STATUSES },
      },
      select: { id: true },
    });

    if (duplicate) {
      return res.status(409).json({
        message:
          "You already have an active SOS. Wait for resolution or cancel it from the app.",
        existingAlertId: duplicate.id,
      });
    }

    const alert = await prisma.sOSAlert.create({
      data: {
        societyId,
        villaId,
        triggeredBy: userId,
        emergencyType: emergencyType as SOSType,
        message,
        location,
        latitude,
        longitude,
        status: SOSStatus.CREATED,
      },
      include: alertInclude,
    });

    const vl = villaLabelFromAlert(alert as any);

    void notifySocietyRoles({
      societyId,
      roles: [UserRole.GUARD, UserRole.ADMIN],
      category: NotificationCategory.SOS,
      title: `🚨 SOS: ${emergencyType}`,
      body: `${alert.user.name} · ${vl}${message ? ` · ${message}` : ""}`,
      data: {
        alertId: alert.id,
        villaId,
        emergencyType,
        type: "SOS_CREATED",
      },
    }).catch((err) => console.error("[notifications] SOS push failed:", err));

    scheduleSosEscalation(alert.id, societyId, vl, emergencyType);

    return res.status(201).json({
      alert,
      message: "SOS alert triggered. Guards and admin have been notified.",
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/sos-alerts - List SOS alerts (guards/admin)
router.get("/", requireAuth, requireRole(UserRole.ADMIN, UserRole.GUARD), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { status, villaId } = req.query;

    const where: Record<string, unknown> = { societyId };
    if (status) where.status = status;
    if (villaId) where.villaId = villaId;

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

      clearSosEscalation(id);

      const acknowledgedAt = new Date();
      const responseTimeSec = Math.floor(
        (acknowledgedAt.getTime() - alert.createdAt.getTime()) / 1000,
      );

      const updatedAlert = await prisma.sOSAlert.update({
        where: { id },
        data: {
          status: SOSStatus.ACKNOWLEDGED,
          acknowledgedBy: userId,
          acknowledgedAt,
          responseTime: responseTimeSec,
          assignedGuardId: userId,
        },
        include: alertInclude,
      });

      void notifyResidentSosUpdate({
        alertId: id,
        residentUserId: alert.triggeredBy,
        title: "Help is on the way",
        body: "A guard has acknowledged your SOS.",
        extraData: { sosStatus: SOSStatus.ACKNOWLEDGED },
      }).catch(() => undefined);

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

      const updatedAlert = await prisma.sOSAlert.update({
        where: { id },
        data: {
          status: SOSStatus.IN_PROGRESS,
          inProgressAt: new Date(),
          assignedGuardId: userId,
        },
        include: alertInclude,
      });

      void notifyResidentSosUpdate({
        alertId: id,
        residentUserId: alert.triggeredBy,
        title: "Response in progress",
        body: "Emergency responders are attending your SOS.",
        extraData: { sosStatus: SOSStatus.IN_PROGRESS },
      }).catch(() => undefined);

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

      clearSosEscalation(id);

      const resolvedAt = new Date();
      const resolutionSeconds = Math.floor(
        (resolvedAt.getTime() - alert.createdAt.getTime()) / 1000,
      );

      const updatedAlert = await prisma.sOSAlert.update({
        where: { id },
        data: {
          status: SOSStatus.RESOLVED,
          resolvedBy: userId,
          resolvedAt,
          responseTime: alert.responseTime ?? resolutionSeconds,
        },
        include: alertInclude,
      });

      void notifyResidentSosUpdate({
        alertId: id,
        residentUserId: alert.triggeredBy,
        title: "SOS resolved",
        body: "Your emergency alert has been closed by security.",
        extraData: { sosStatus: SOSStatus.RESOLVED },
      }).catch(() => undefined);

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
  requireRole(UserRole.RESIDENT),
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

      clearSosEscalation(id);

      const updated = await prisma.sOSAlert.update({
        where: { id },
        data: {
          status: SOSStatus.CANCELLED,
          cancelReason: reason,
          resolvedAt: new Date(),
        },
        include: alertInclude,
      });

      void notifySocietyRoles({
        societyId,
        roles: [UserRole.GUARD, UserRole.ADMIN],
        category: NotificationCategory.SOS,
        title: "SOS cancelled by resident",
        body: reason,
        data: { alertId: id, type: "SOS_CANCELLED" },
      }).catch(() => undefined);

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
