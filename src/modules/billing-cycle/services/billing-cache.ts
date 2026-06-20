import { cache } from "../../../lib/cache";

const MEMORY = new Map<string, { expiresAtMs: number; value: string }>();

const DEFAULT_TTL_SEC = Number(process.env.BILLING_CURRENT_CYCLE_CACHE_SEC ?? "120");

export async function billingCacheGet(key: string): Promise<string | null> {
  const fromRedis = await cache.getString(key);
  if (fromRedis !== null) return fromRedis;

  const row = MEMORY.get(key);
  if (!row) return null;
  if (Date.now() > row.expiresAtMs) {
    MEMORY.delete(key);
    return null;
  }
  return row.value;
}

export async function billingCacheSet(key: string, value: string, ttlSec = DEFAULT_TTL_SEC): Promise<void> {
  await cache.setString(key, value, ttlSec);
  MEMORY.set(key, { value, expiresAtMs: Date.now() + ttlSec * 1000 });
}

export async function billingCacheInvalidateByPrefix(prefix: string): Promise<void> {
  await cache.delPattern(`${prefix}*`);
  for (const key of MEMORY.keys()) {
    if (key.startsWith(prefix)) MEMORY.delete(key);
  }
}

export async function billingCacheDel(key: string): Promise<void> {
  await cache.del(key);
  MEMORY.delete(key);
}

export const billingCurrentCycleKey = (societyId: string) =>
  `billing:current-cycle:${encodeURIComponent(societyId)}`;
