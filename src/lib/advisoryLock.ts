import { prisma } from "./prisma";

/**
 * Runs `fn` only if this process can acquire the Postgres advisory lock at
 * `lockKey`. Used by the in-process cron in [server.ts] so background work
 * still runs on a single replica when the API is horizontally scaled — the
 * second-to-Nth replica simply skips. Releases the lock in `finally` so a
 * crashing job doesn't deadlock the next tick.
 *
 * Returns the `fn` result on success, or `null` when the lock was not
 * acquired (so callers can distinguish "didn't run" from "ran and returned
 * undefined").
 *
 * Lock keys are arbitrary 64-bit ints; pick distinct constants per job.
 */
export async function withAdvisoryLock<T>(
  lockKey: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const result = await prisma.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(${lockKey}) AS locked
  `;
  if (!result[0]?.locked) return null;
  try {
    return await fn();
  } finally {
    // Best-effort release. If this fails, Postgres will release the lock
    // when the connection is returned to the pool / closes anyway.
    try {
      await prisma.$executeRaw`SELECT pg_advisory_unlock(${lockKey})`;
    } catch {
      // swallowed intentionally
    }
  }
}

/**
 * Stable lock keys for in-process cron jobs. Append new entries here so
 * they are easy to find and impossible to collide.
 */
export const AdvisoryLockKeys = {
  billingCycleHourly: 4242_0001,
} as const;
