import { PrismaClient } from "@prisma/client";
import { logger } from "./logger";

/**
 * Dedicated Prisma client for advisory locks — uses DIRECT_URL when set so
 * locks are not released by PgBouncer/Neon pooler when the connection returns
 * to the pool mid-cron.
 */
let lockPrisma: PrismaClient | null = null;

function getLockPrisma(): PrismaClient {
  if (!lockPrisma) {
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is required for advisory locks");
    }
    lockPrisma = new PrismaClient({
      datasources: { db: { url } },
    });
    if (!process.env.DIRECT_URL) {
      logger.warn(
        "[advisoryLock] DIRECT_URL not set — using DATABASE_URL for cron locks. "
          + "Set DIRECT_URL to a non-pooled connection in production.",
      );
    }
  }
  return lockPrisma;
}

/**
 * Runs `fn` only if this process can acquire the Postgres advisory lock at
 * `lockKey`. The lock is held on a dedicated session for the entire duration
 * of `fn`, so horizontally scaled replicas skip duplicate cron work.
 *
 * Returns the `fn` result on success, or `null` when the lock was not acquired.
 */
export async function withAdvisoryLock<T>(
  lockKey: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const client = getLockPrisma();

  return client.$transaction(
    async (tx) => {
      const result = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_lock(${lockKey}) AS locked
      `;
      if (!result[0]?.locked) return null;

      try {
        return await fn();
      } finally {
        try {
          await tx.$executeRaw`SELECT pg_advisory_unlock(${lockKey})`;
        } catch {
          // Session end releases the lock if unlock fails.
        }
      }
    },
    { maxWait: 10_000, timeout: 600_000 },
  );
}

/**
 * Stable lock keys for in-process cron jobs. Append new entries here so
 * they are easy to find and impossible to collide.
 */
export const AdvisoryLockKeys = {
  billingCycleHourly: 4242_0001,
} as const;
