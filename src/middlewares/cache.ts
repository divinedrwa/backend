/**
 * Cache Middleware
 * 
 * Usage:
 *   router.get("/list", cacheMiddleware(300), handler);
 * 
 * Features:
 * - Automatic cache key generation from URL + query params + user
 * - Only caches successful 200 responses
 * - Graceful degradation if Redis fails
 * - Society-scoped (auto-invalidate on tenant switch)
 */

import type { Request, Response, NextFunction } from "express";
import { cache } from "../lib/cache";

export function cacheMiddleware(ttlSeconds: number = 300) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Only cache GET requests
    if (req.method !== "GET") {
      return next();
    }

    // Build cache key from route + query + user + society
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const auth = (req as any).auth;
    const societyId = auth?.societyId || "public";
    const userId = auth?.userId || "anon";
    const queryStr = JSON.stringify(req.query);
    const cacheKey = `api:${societyId}:${req.path}:${userId}:${queryStr}`;

    // Try cache first
    const cached = await cache.get<{ status: number; body: unknown }>(cacheKey);
    if (cached) {
      return res.status(cached.status).json(cached.body);
    }

    // Intercept response
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      // Only cache 200 responses
      if (res.statusCode === 200) {
        cache.set(cacheKey, { status: res.statusCode, body }, ttlSeconds).catch(() => {
          // Graceful degradation - don't block response
        });
      }
      return originalJson(body);
    };

    next();
  };
}

/**
 * Invalidate cache for a society
 * Call after mutations (create/update/delete)
 */
export async function invalidateSocietyCache(societyId: number, pattern?: string) {
  const basePattern = `api:${societyId}:${pattern || "*"}`;
  await cache.delPattern(basePattern);
}
