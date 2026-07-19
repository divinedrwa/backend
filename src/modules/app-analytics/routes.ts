import { AppAnalyticsEventKind, AppAnalyticsPlatform, UserRole } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import {
  createAnalyticsSession,
  getAppAnalyticsActions,
  getAppAnalyticsActiveUsers,
  getAppAnalyticsDailyTrend,
  getAppAnalyticsErrors,
  getAppAnalyticsFlows,
  getAppAnalyticsInsights,
  getAppAnalyticsSummary,
  getAppAnalyticsTopScreens,
  getAppAnalyticsUserEngagement,
  recordAnalyticsEvent,
  recordAnalyticsEventBatch,
  touchAnalyticsSession,
} from "./appAnalytics.service";
import {
  ADMIN_READ_ROLES,
  analyticsEventSchema,
  batchEventsSchema,
  INGEST_ROLES,
  patchSessionSchema,
  startSessionSchema,
  summaryQuerySchema,
} from "./schemas";
import { loadAnalyticsUserSnapshot } from "./userSnapshot";
import { getAppAnalyticsGrowthDashboard } from "./growthDashboard.service";

const router = Router();

router.use(requireAuth);

function tenantSocietyId(req: { auth?: { societyId: string | null } }): string | null {
  return req.auth?.societyId ?? null;
}

function parseDays(raw: unknown, fallback = 30): number {
  const parsed = summaryQuerySchema.safeParse({ days: raw ?? fallback });
  return parsed.success ? parsed.data.days : fallback;
}

// ── Ingest (all tenant mobile roles) ───────────────────────────────

router.post(
  "/sessions",
  requireRole(...INGEST_ROLES),
  validateBody(startSessionSchema),
  async (req, res, next) => {
    try {
      const societyId = tenantSocietyId(req);
      const { userId, role } = req.auth!;
      if (!societyId || !userId || !role) {
        return res.status(403).json({ message: "Tenant context required" });
      }

      const userSnapshot = await loadAnalyticsUserSnapshot(prisma, societyId, userId);

      const session = await createAnalyticsSession(prisma, {
        societyId,
        userId,
        role,
        body: req.body,
        userSnapshot,
      });

      await recordAnalyticsEvent(prisma, {
        societyId,
        userId,
        role,
        defaultPlatform: req.body.platform as AppAnalyticsPlatform,
        defaultAppVersion: req.body.appVersion,
        userSnapshot,
        event: {
          kind: AppAnalyticsEventKind.SESSION_START,
          name: "session_start",
          clientEventId: `sess-start-${session.id}`,
          sessionId: session.id,
          platform: req.body.platform,
          appVersion: req.body.appVersion,
        },
      });

      return res.status(201).json({ session });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  "/sessions/:id",
  requireRole(...INGEST_ROLES),
  validateBody(patchSessionSchema),
  async (req, res, next) => {
    try {
      const societyId = tenantSocietyId(req);
      if (!societyId) {
        return res.status(403).json({ message: "Tenant context required" });
      }

      const updated = await touchAnalyticsSession(prisma, {
        societyId,
        sessionId: req.params.id,
        ended: req.body.ended === true,
      });
      if (!updated) {
        return res.status(404).json({ message: "Session not found" });
      }

      if (req.body.ended === true) {
        const { userId, role } = req.auth!;
        if (userId && role) {
          const sessionRow = await prisma.appAnalyticsSession.findFirst({
            where: { id: req.params.id, societyId },
            select: { platform: true, appVersion: true },
          });
          const userSnapshot = await loadAnalyticsUserSnapshot(prisma, societyId, userId);
          await recordAnalyticsEvent(prisma, {
            societyId,
            userId,
            role,
            defaultPlatform: sessionRow?.platform ?? AppAnalyticsPlatform.ANDROID,
            defaultAppVersion: sessionRow?.appVersion ?? undefined,
            userSnapshot,
            event: {
              kind: AppAnalyticsEventKind.SESSION_END,
              name: "session_end",
              clientEventId: `sess-end-${req.params.id}`,
              sessionId: req.params.id,
            },
          });
        }
      }

      return res.json({ session: updated });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/events",
  requireRole(...INGEST_ROLES),
  validateBody(analyticsEventSchema),
  async (req, res, next) => {
    try {
      const societyId = tenantSocietyId(req);
      const { userId, role } = req.auth!;
      if (!societyId || !userId || !role) {
        return res.status(403).json({ message: "Tenant context required" });
      }

      const platform =
        (req.body.platform as AppAnalyticsPlatform | undefined) ??
        AppAnalyticsPlatform.ANDROID;

      const userSnapshot = await loadAnalyticsUserSnapshot(prisma, societyId, userId);

      const event = await recordAnalyticsEvent(prisma, {
        societyId,
        userId,
        role,
        defaultPlatform: platform,
        defaultAppVersion: req.body.appVersion,
        userSnapshot,
        event: req.body,
      });

      return res.status(201).json({ event });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/events/batch",
  requireRole(...INGEST_ROLES),
  validateBody(batchEventsSchema),
  async (req, res, next) => {
    try {
      const societyId = tenantSocietyId(req);
      const { userId, role } = req.auth!;
      if (!societyId || !userId || !role) {
        return res.status(403).json({ message: "Tenant context required" });
      }

      const userSnapshot = await loadAnalyticsUserSnapshot(prisma, societyId, userId);
      const firstPlatform =
        (req.body.events[0]?.platform as AppAnalyticsPlatform | undefined) ??
        AppAnalyticsPlatform.ANDROID;

      const result = await recordAnalyticsEventBatch(prisma, {
        societyId,
        userId,
        role,
        defaultPlatform: firstPlatform,
        userSnapshot,
        events: req.body.events,
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// ── Admin read APIs ──────────────────────────────────────────────────

router.get("/summary", requireRole(...ADMIN_READ_ROLES), async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }
    const days = parseDays(req.query.days);
    const summary = await getAppAnalyticsSummary(prisma, societyId, days);
    return res.json({ summary });
  } catch (error) {
    next(error);
  }
});

router.get("/daily-trend", requireRole(...ADMIN_READ_ROLES), async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }
    const days = parseDays(req.query.days, 7);
    const trend = await getAppAnalyticsDailyTrend(prisma, societyId, days);
    return res.json(trend);
  } catch (error) {
    next(error);
  }
});

router.get("/screens", requireRole(...ADMIN_READ_ROLES), async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }
    const days = parseDays(req.query.days);
    const screens = await getAppAnalyticsTopScreens(prisma, societyId, days);
    return res.json(screens);
  } catch (error) {
    next(error);
  }
});

router.get("/flows", requireRole(...ADMIN_READ_ROLES), async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }
    const days = parseDays(req.query.days);
    const flows = await getAppAnalyticsFlows(prisma, societyId, days);
    return res.json(flows);
  } catch (error) {
    next(error);
  }
});

router.get("/actions", requireRole(...ADMIN_READ_ROLES), async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }
    const days = parseDays(req.query.days);
    const summary = await getAppAnalyticsSummary(prisma, societyId, days);
    const registered =
      summary.engagement.registeredActiveAccounts ?? summary.totals.registeredAccounts;
    const actions = await getAppAnalyticsActions(prisma, societyId, days, registered);
    return res.json(actions);
  } catch (error) {
    next(error);
  }
});

router.get("/errors", requireRole(...ADMIN_READ_ROLES), async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }
    const days = parseDays(req.query.days);
    const errors = await getAppAnalyticsErrors(prisma, societyId, days);
    return res.json(errors);
  } catch (error) {
    next(error);
  }
});

router.get("/insights", requireRole(...ADMIN_READ_ROLES), async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }
    const days = parseDays(req.query.days);
    const insights = await getAppAnalyticsInsights(prisma, societyId, days);
    return res.json({ insights });
  } catch (error) {
    next(error);
  }
});

router.get("/growth-dashboard", requireRole(...ADMIN_READ_ROLES), async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }
    const days = parseDays(req.query.days);
    const dashboard = await getAppAnalyticsGrowthDashboard(prisma, societyId, days);
    return res.json({ growth: dashboard });
  } catch (error) {
    next(error);
  }
});

router.get("/active-users", requireRole(...ADMIN_READ_ROLES), async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }
    const days = parseDays(req.query.days, 7);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
    const activeUsers = await getAppAnalyticsActiveUsers(prisma, societyId, days, limit);
    return res.json(activeUsers);
  } catch (error) {
    next(error);
  }
});

router.get("/user-engagement", requireRole(...ADMIN_READ_ROLES), async (req, res, next) => {
  try {
    const societyId = tenantSocietyId(req);
    if (!societyId) {
      return res.status(403).json({ message: "Tenant context required" });
    }
    const days = parseDays(req.query.days);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
    const engagement = await getAppAnalyticsUserEngagement(prisma, societyId, days, limit);
    return res.json({ engagement });
  } catch (error) {
    next(error);
  }
});

export default router;
