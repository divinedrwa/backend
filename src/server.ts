// Sentry must be initialized before all other imports for auto-instrumentation
import "./instrument";

import cron from "node-cron";
import { app } from "./app";
import { env, validateProductionEnv } from "./config/env";
import { AdvisoryLockKeys, withAdvisoryLock } from "./lib/advisoryLock";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { runBillingReminderJobs, syncAllBillingCycleStatuses } from "./modules/billing-cycle/services/cycle-service";
import { reconcileAllSocieties } from "./lib/reconciliation";
import { autoGenerateNextMaintenanceCycles } from "./lib/autoMaintenanceCycle";
import { NotificationService } from "./services/notification.service";
import { applyLateFees } from "./services/lateFee.service";
import { autoCloseResolvedComplaints, checkComplaintSlaBreaches } from "./services/complaintSla.service";
import { processEscalations } from "./services/sos-coordinator";
import { processWaterStillOnReminders } from "./services/waterStillOnReminder.service";
import { processVisitorOverstayAlerts } from "./services/visitorPassAudit.service";
import { closeUnmarkedExits } from "./modules/guards/visitor-state-manager";
import { localDayRange } from "./lib/societyTime";

validateProductionEnv();

const host = process.env.HOST ?? "0.0.0.0";
const server = app.listen(env.PORT, host, () => {
  logger.info({ host, port: env.PORT }, "API listening");
});

// Request & connection timeouts
server.timeout = 30_000; // 30s per request
server.keepAliveTimeout = 65_000; // slightly above typical LB idle timeout (60s)
server.headersTimeout = 66_000; // must exceed keepAliveTimeout

/* ── Graceful shutdown ────────────────────────────────────────── */
async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down gracefully");
  server.close(() => {
    prisma.$disconnect().then(() => {
      logger.info("Prisma disconnected, exiting");
      process.exit(0);
    });
  });
  // Force exit after 10 seconds if connections don't drain
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/* ── Crash safety ─────────────────────────────────────────────── */
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — shutting down");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection — shutting down");
  process.exit(1);
});

/**
 * UTC hourly: persist cycle enum from windows + reminder notifications.
 *
 * Wrapped in a Postgres advisory lock so when the API runs with multiple
 * replicas, exactly one of them executes the job per tick. Replicas that
 * lose the race log a debug-level skip instead of duplicating reminders.
 */
cron.schedule(
  "0 * * * *",
  async () => {
    try {
      const ran = await withAdvisoryLock(
        AdvisoryLockKeys.billingCycleHourly,
        async () => {
          const steps: Array<{ name: string; fn: () => Promise<void> }> = [
            {
              name: "syncBillingCycleStatuses",
              fn: async () => { await syncAllBillingCycleStatuses(); },
            },
            {
              name: "billingReminders",
              fn: async () => { await runBillingReminderJobs(); },
            },
            {
              name: "autoMaintenanceCycles",
              fn: async () => {
                const r = await autoGenerateNextMaintenanceCycles();
                if (r.cyclesCreated > 0) {
                  logger.info(r, "[billing-cron] Auto maintenance cycles");
                }
              },
            },
            {
              name: "ledgerReconciliation",
              fn: async () => {
                logger.info("[billing-cron] Running ledger reconciliation");
                const reconResult = await reconcileAllSocieties();
                logger.info({
                  total: reconResult.total,
                  successful: reconResult.successful,
                  failed: reconResult.failed,
                  alertsCreated: reconResult.totalAlerts,
                }, "[billing-cron] Reconciliation complete");
              },
            },
            {
              name: "applyLateFees",
              fn: async () => { await applyLateFees(); },
            },
            {
              name: "complaintSlaBreaches",
              fn: async () => { await checkComplaintSlaBreaches(); },
            },
            {
              name: "autoCloseComplaints",
              fn: async () => { await autoCloseResolvedComplaints(); },
            },
            {
              name: "sosEscalations",
              fn: async () => {
                const escalationsProcessed = await prisma.$transaction(async (tx) => {
                  return await processEscalations(tx);
                });
                if (escalationsProcessed > 0) {
                  logger.info({ escalationsProcessed }, "[billing-cron] SOS escalations processed");
                }
              },
            },
            {
              name: "deactivateExpiredPreApprovals",
              fn: async () => {
                const { count: deactivatedPreApprovals } = await prisma.preApprovedVisitor.updateMany({
                  where: {
                    isActive: true,
                    isUsed: false,
                    validUntil: { lt: new Date() },
                  },
                  data: { isActive: false },
                });
                if (deactivatedPreApprovals > 0) {
                  logger.info({ deactivatedPreApprovals }, "[billing-cron] Deactivated expired pre-approvals");
                }
              },
            },
            {
              name: "expireStaleGateRequests",
              fn: async () => {
                // Walk-in requests nobody answered/admitted for 12h are closed so they
                // stop cluttering the guard queue and don't block a fresh request.
                const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
                const { count: expiredGateRequests } = await prisma.visitor.updateMany({
                  where: {
                    status: { in: ["PENDING_APPROVAL", "APPROVED"] },
                    checkOutAt: null,
                    checkInTime: { lt: cutoff },
                  },
                  data: { status: "CANCELLED" },
                });
                if (expiredGateRequests > 0) {
                  logger.info({ expiredGateRequests }, "[billing-cron] Expired stale gate requests");
                }
              },
            },
            {
              name: "closeUnmarkedExits",
              fn: async () => {
                // Visits from an earlier society-local day, and at least 12h old (so an
                // overnight guest isn't closed right after midnight).
                const now = new Date();
                const todayStart = localDayRange(now).start;
                const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);
                const cutoff = todayStart < twelveHoursAgo ? todayStart : twelveHoursAgo;
                await closeUnmarkedExits(prisma, { checkInTime: { lt: cutoff } }, now);
              },
            },
            {
              name: "cleanupInactiveDevices",
              fn: async () => { await NotificationService.cleanupInactiveDevices(); },
            },
            {
              name: "purgeExpiredRefreshTokens",
              fn: async () => {
                // Rotated tokens are kept for an hour so the refresh grace window
                // can still find them.
                const rotatedCutoff = new Date(Date.now() - 60 * 60 * 1000);
                const { count: purgedTokens } = await prisma.refreshToken.deleteMany({
                  where: {
                    OR: [
                      { expiresAt: { lt: new Date() }, revoked: false },
                      { revoked: true, rotatedAt: null },
                      { revoked: true, rotatedAt: { lt: rotatedCutoff } },
                    ],
                  },
                });
                if (purgedTokens > 0) {
                  logger.info({ purgedTokens }, "[billing-cron] Purged expired/revoked refresh tokens");
                }
              },
            },
          ];

          for (const step of steps) {
            try {
              await step.fn();
            } catch (stepErr) {
              logger.error({ err: stepErr, step: step.name }, `[billing-cron] step "${step.name}" failed, continuing`);
            }
          }

          return true;
        },
      );
      if (ran === null) {
        logger.debug("[billing-cron] lock not acquired; another replica owns this tick");
      }
    } catch (e) {
      logger.error({ err: e }, "[billing-cron] failed");
    }
  },
  { timezone: "Etc/UTC" }
);

/**
 * Every minute: if a water motor has been ON for ≥30 minutes (configurable via
 * WATER_STILL_ON_REMINDER_MINUTES) with no newer OFF/ON, push all guards + admins
 * to check the tank and switch the motor OFF.
 */
cron.schedule(
  "* * * * *",
  async () => {
    try {
      const ran = await withAdvisoryLock(AdvisoryLockKeys.waterStillOnReminder, async () => {
        return processWaterStillOnReminders();
      });
      if (ran === null) {
        logger.debug("[water-still-on] lock not acquired; another replica owns this tick");
        return;
      }
      if (ran.sent > 0 || ran.suppressed > 0) {
        logger.info(ran, "[water-still-on] tick complete");
      }
    } catch (e) {
      logger.error({ err: e }, "[water-still-on] cron failed");
    }
  },
  { timezone: "Etc/UTC" },
);

/**
 * Every 5 minutes: alert residents and guards when a checked-in visitor
 * exceeds the expected checkout window for their visitor type.
 */
cron.schedule(
  "*/5 * * * *",
  async () => {
    try {
      const ran = await withAdvisoryLock(AdvisoryLockKeys.visitorOverstayReminder, async () => {
        return processVisitorOverstayAlerts();
      });
      if (ran === null) {
        logger.debug("[visitor-overstay] lock not acquired; another replica owns this tick");
        return;
      }
      if (ran.notified > 0) {
        logger.info(ran, "[visitor-overstay] tick complete");
      }
    } catch (e) {
      logger.error({ err: e }, "[visitor-overstay] cron failed");
    }
  },
  { timezone: "Etc/UTC" },
);
