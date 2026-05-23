import cron from "node-cron";
import { app } from "./app";
import { env } from "./config/env";
import { AdvisoryLockKeys, withAdvisoryLock } from "./lib/advisoryLock";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { runBillingReminderJobs, syncAllBillingCycleStatuses } from "./modules/billing-cycle/services/cycle-service";
import { reconcileAllSocieties } from "./lib/reconciliation";
import { NotificationService } from "./services/notification.service";

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
          await syncAllBillingCycleStatuses();
          await runBillingReminderJobs();
          
          // 🔥 NEW: Run financial reconciliation
          logger.info("[billing-cron] Running ledger reconciliation");
          const reconResult = await reconcileAllSocieties();
          logger.info({
            total: reconResult.total,
            successful: reconResult.successful,
            failed: reconResult.failed,
            alertsCreated: reconResult.totalAlerts,
          }, "[billing-cron] Reconciliation complete");

          // Clean up stale inactive push devices (>90 days)
          await NotificationService.cleanupInactiveDevices();

          // Purge expired or revoked refresh tokens (>7 days past expiry)
          const { count: purgedTokens } = await prisma.refreshToken.deleteMany({
            where: {
              OR: [
                { expiresAt: { lt: new Date() }, revoked: false },
                { revoked: true },
              ],
            },
          });
          if (purgedTokens > 0) {
            logger.info({ purgedTokens }, "[billing-cron] Purged expired/revoked refresh tokens");
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
