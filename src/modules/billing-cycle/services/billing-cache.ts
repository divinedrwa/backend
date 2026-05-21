import Redis from "ioredis";
import { logger } from "../../../lib/logger";

const MEMORY = new Map<string, { expiresAtMs: number; value: string }>();

let redisClient: Redis | null = null;

function getRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!redisClient) {
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 3000)),
    });
    redisClient.on("error", (err) => {
      logger.error({ err }, "[billing-cache] Redis error");
    });
  }
  return redisClient;
}

const DEFAULT_TTL_SEC = Number(process.env.BILLING_CURRENT_CYCLE_CACHE_SEC ?? "120");

export async function billingCacheGet(key: string): Promise<string | null> {
  const r = getRedis();
  if (r) {
    try {
      return await r.get(key);
    } catch {
      return null;
    }
  }
  const row = MEMORY.get(key);
  if (!row) return null;
  if (Date.now() > row.expiresAtMs) {
    MEMORY.delete(key);
    return null;
  }
  return row.value;
}

export async function billingCacheSet(key: string, value: string, ttlSec = DEFAULT_TTL_SEC): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      await r.set(key, value, "EX", ttlSec);
      return;
    } catch {
      // fall through memory
    }
  }
  MEMORY.set(key, { value, expiresAtMs: Date.now() + ttlSec * 1000 });
}

export async function billingCacheInvalidateByPrefix(prefix: string): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      const keys = await r.keys(`${prefix}*`);
      if (keys.length) await r.del(...keys);
    } catch {
      /* noop */
    }
  }
  for (const key of MEMORY.keys()) {
    if (key.startsWith(prefix)) MEMORY.delete(key);
  }
}

export async function billingCacheDel(key: string): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      await r.del(key);
      return;
    } catch {
      /* fall through */
    }
  }
  MEMORY.delete(key);
}

export const billingCurrentCycleKey = (societyId: string) =>
  `billing:current-cycle:${encodeURIComponent(societyId)}`;
