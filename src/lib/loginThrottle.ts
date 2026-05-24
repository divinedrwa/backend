/**
 * In-memory per-account brute-force protection.
 *
 * Tracks consecutive failed login attempts per identifier (username/email).
 * After a threshold of failures the account is temporarily locked for a
 * progressively longer cooldown.
 *
 * Thresholds:
 *   5 failures →  1 min lockout
 *  10 failures →  5 min lockout
 *  15 failures → 15 min lockout
 *  20+ failures → 30 min lockout
 *
 * On a successful login the counter resets. Stale entries are cleaned every
 * 30 minutes so the Map doesn't grow without bound.
 */

interface AttemptRecord {
  failures: number;
  lockedUntil: number; // epoch ms; 0 = not locked
  lastAttempt: number; // epoch ms
}

const store = new Map<string, AttemptRecord>();

const THRESHOLDS: { failures: number; lockoutMs: number }[] = [
  { failures: 5, lockoutMs: 1 * 60_000 },
  { failures: 10, lockoutMs: 5 * 60_000 },
  { failures: 15, lockoutMs: 15 * 60_000 },
  { failures: 20, lockoutMs: 30 * 60_000 },
];

function lockoutForFailures(failures: number): number {
  let lockout = 0;
  for (const t of THRESHOLDS) {
    if (failures >= t.failures) lockout = t.lockoutMs;
  }
  return lockout;
}

/** Build a throttle key. Use `societyId + identifier` to scope per tenant. */
export function throttleKey(societyId: string | null, identifier: string): string {
  const id = identifier.toLowerCase().trim();
  return societyId ? `${societyId}:${id}` : `__super__:${id}`;
}

/**
 * Check whether the account is currently locked. Returns `null` if the
 * account is free to attempt login, or the number of **seconds** remaining
 * on the lockout otherwise.
 */
export function checkLoginThrottle(key: string): number | null {
  const record = store.get(key);
  if (!record) return null;
  if (record.lockedUntil <= Date.now()) return null;
  return Math.ceil((record.lockedUntil - Date.now()) / 1000);
}

/** Record a failed login attempt and apply a lockout if thresholds are met. */
export function recordLoginFailure(key: string): void {
  const now = Date.now();
  const record = store.get(key) ?? { failures: 0, lockedUntil: 0, lastAttempt: 0 };
  record.failures += 1;
  record.lastAttempt = now;
  const lockoutMs = lockoutForFailures(record.failures);
  if (lockoutMs > 0) {
    record.lockedUntil = now + lockoutMs;
  }
  store.set(key, record);
}

/** Reset the counter after a successful login. */
export function clearLoginThrottle(key: string): void {
  store.delete(key);
}

// Periodic cleanup: remove entries older than 1 hour with no active lock.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [key, record] of store) {
    if (record.lastAttempt < cutoff && record.lockedUntil <= Date.now()) {
      store.delete(key);
    }
  }
}, 30 * 60_000).unref();
