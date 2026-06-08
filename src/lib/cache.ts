/**
 * Redis Cache Service
 * 
 * SETUP INSTRUCTIONS:
 * 1. Deploy Redis (Upstash free tier: https://upstash.com)
 * 2. Add to .env: REDIS_URL=redis://default:xxxxx@region.upstash.io:6379
 * 3. Cache automatically handles connection failures gracefully
 * 
 * USAGE:
 *   import { cache } from "./lib/cache";
 * 
 *   // Wrap expensive queries
 *   const data = await cache.wrap("societies", 300, async () => {
 *     return await prisma.society.findMany();
 *   });
 * 
 *   // Invalidate on mutations
 *   await cache.del("societies");
 */

import Redis from "ioredis";
import { logger } from "./logger";

class CacheService {
  private client: Redis | null = null;
  private isEnabled: boolean = false;

  constructor() {
    const url = process.env.REDIS_URL;
    
    if (!url) {
      logger.info("[Cache] Skipped - REDIS_URL not configured");
      return;
    }

    try {
      this.client = new Redis(url, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: true,
      });

      // Connect without blocking startup
      this.client.connect().then(() => {
        this.isEnabled = true;
        logger.info("[Cache] Connected to Redis");
      }).catch((err) => {
        logger.error({ err }, "[Cache] Connection failed - running without cache");
      });

      // Graceful degradation on errors
      this.client.on("error", (err) => {
        logger.error({ err }, "[Cache] Redis error - cache degraded");
        this.isEnabled = false;
      });

      this.client.on("reconnecting", () => {
        logger.info("[Cache] Reconnecting to Redis");
      });

      this.client.on("ready", () => {
        this.isEnabled = true;
        logger.info("[Cache] Redis ready");
      });

    } catch (err) {
      logger.error({ err }, "[Cache] Init failed - running without cache");
    }
  }

  /**
   * Get cached value. Returns { hit: true, value } on cache hit,
   * { hit: false } on miss, so callers can distinguish null values from misses.
   */
  async getRaw<T>(key: string): Promise<{ hit: true; value: T } | { hit: false }> {
    if (!this.isEnabled || !this.client) return { hit: false };

    try {
      const data = await this.client.get(key);
      if (data === null) return { hit: false };
      return { hit: true, value: JSON.parse(data) as T };
    } catch (err) {
      logger.error({ err, key }, "[Cache] Get failed");
      return { hit: false };
    }
  }

  /**
   * Get cached value (convenience — returns null on miss).
   * Cannot distinguish a cached null from a miss; use getRaw() when that matters.
   */
  async get<T>(key: string): Promise<T | null> {
    const result = await this.getRaw<T>(key);
    return result.hit ? result.value : null;
  }

  /**
   * Set cached value with TTL (seconds)
   */
  async set(key: string, value: unknown, ttl: number): Promise<void> {
    if (!this.isEnabled || !this.client) return;
    
    try {
      await this.client.setex(key, ttl, JSON.stringify(value));
    } catch (err) {
      logger.error({ err, key }, "[Cache] Set failed");
    }
  }

  /**
   * Delete cached value(s)
   */
  async del(...keys: string[]): Promise<void> {
    if (!this.isEnabled || !this.client || keys.length === 0) return;
    
    try {
      await this.client.del(...keys);
    } catch (err) {
      logger.error({ err, keys }, "[Cache] Del failed");
    }
  }

  /**
   * Wrap a function with caching
   * Returns cached value if available, otherwise executes fn and caches result
   */
  async wrap<T>(
    key: string,
    ttl: number,
    fn: () => Promise<T>
  ): Promise<T> {
    // Try cache first — use getRaw to correctly handle cached null/falsy values
    const cached = await this.getRaw<T>(key);
    if (cached.hit) {
      return cached.value;
    }

    // Execute function
    const result = await fn();

    // Cache result
    await this.set(key, result, ttl);

    return result;
  }

  /**
   * Delete all keys matching pattern using SCAN (safe for production).
   * Unlike KEYS, SCAN is non-blocking and iterates incrementally.
   */
  async delPattern(pattern: string): Promise<void> {
    if (!this.isEnabled || !this.client) return;

    try {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await this.client.scan(
          cursor, "MATCH", pattern, "COUNT", 100,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await this.client.del(...keys);
        }
      } while (cursor !== "0");
    } catch (err) {
      logger.error({ err, pattern }, "[Cache] DelPattern failed");
    }
  }
}

export const cache = new CacheService();
