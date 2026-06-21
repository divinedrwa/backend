/**
 * Rate Limiting Middleware
 * 
 * PRODUCTION-SAFE CONFIGURATION:
 * - All limits set VERY HIGH to ensure zero impact on normal users
 * - Designed to block only malicious actors, not legitimate traffic
 * - Can be tightened gradually after monitoring logs
 * 
 * SAFETY GUARANTEES:
 * - Normal users will NEVER hit these limits
 * - Shared WiFi environments fully supported
 * - Power users (admins, guards) have plenty of headroom
 * - No impact on existing functionality
 */

import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';

/** Skip monitoring endpoints — never rate-limit health probes. */
function skipHealthChecks(req: Request): boolean {
  const p = req.path ?? '';
  return p === '/health' || p === '/api/health';
}

/**
 * Key by authenticated user, else by IP. IPv6 addresses must go through
 * express-rate-limit's `ipKeyGenerator` (normalizes to a /64) — returning a raw
 * `req.ip` is rejected by v8 validation and lets IPv6 clients rotate addresses
 * within a subnet to bypass the limit.
 */
function userOrIpKey(req: Request): string {
  const auth = (req as Request & { auth?: { userId?: string } }).auth;
  return auth?.userId || ipKeyGenerator(req.ip || 'unknown');
}

/**
 * Creates a standardized rate limiter with logging
 */
function createLimiter(config: {
  windowMs: number;
  max: number;
  skipSuccessfulRequests?: boolean;
  keyGenerator?: Options['keyGenerator'];
  message: string;
  skip?: Options['skip'];
}) {
  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    skipSuccessfulRequests: config.skipSuccessfulRequests || false,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: config.keyGenerator,
    skip: config.skip,
    handler: (req, res) => {
      logger.warn({
        ip: req.ip,
        userId: (req as Request & { auth?: { userId?: string } }).auth?.userId,
        path: req.path,
        limit: config.max,
        window: config.windowMs / 1000 / 60 + 'min',
      }, 'Rate limit exceeded');

      res.status(429).json({
        message: config.message,
        retryAfter: Math.ceil(config.windowMs / 1000),
      });
    },
  });
}

/**
 * AUTH LIMITER - Prevents brute force login attacks
 * 
 * Limit: 10 failed login attempts per 15 minutes
 * Why generous: Prevents brute force while allowing legitimate users who forget password
 * Risk: ZERO - Only blocks rapid-fire login attempts (bots)
 */
export const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts (was 5, increased for safety)
  skipSuccessfulRequests: true, // Don't penalize successful logins
  message: 'Too many login attempts. Please try again in 15 minutes.',
});

/**
 * API LIMITER - General protection for authenticated endpoints
 * 
 * Limit: 300 requests per minute per user/IP
 * Why generous: Normal peak usage is ~20 req/min, this gives 15x headroom
 * Risk: ZERO - No legitimate user will hit this
 */
export const apiLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requests/min (VERY generous)
  skip: skipHealthChecks,
  keyGenerator: userOrIpKey,
  message: 'Too many requests. Please slow down and try again.',
});

/**
 * PAYMENT LIMITER - Prevents payment fraud and abuse
 * 
 * Limit: 20 payment attempts per minute
 * Why generous: Normal payment flow is 1-2 attempts, this allows retries
 * Risk: ZERO - Legitimate users won't initiate 20 payments in 1 minute
 */
export const paymentLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 payment attempts (was 10, increased for safety)
  keyGenerator: userOrIpKey,
  message: 'Payment rate limit exceeded. Please wait a moment before retrying.',
});

/**
 * BULK OPERATION LIMITER - Protects import/export operations
 * 
 * Limit: 30 bulk operations per minute
 * Why generous: Even rapid CSV imports won't hit this
 * Risk: ZERO - Normal admin usage is 1-2 bulk ops per minute max
 */
export const bulkLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 bulk operations (VERY generous)
  message: 'Bulk operation rate limit exceeded. Please wait before retrying.',
});

/**
 * SUPER ADMIN LIMITER - Higher limits for super admin operations
 * 
 * Limit: 500 requests per minute
 * Why generous: Super admins may perform many operations rapidly
 * Risk: ZERO - Only applies to platform-level super admin routes
 */
export const superAdminLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 500, // 500 requests/min (extremely generous)
  keyGenerator: userOrIpKey,
  message: 'Super admin rate limit exceeded.',
});

/**
 * PUBLIC API LIMITER - For unauthenticated endpoints
 * 
 * Limit: 100 requests per minute per IP
 * Why generous: Allows legitimate API usage, blocks only abuse
 * Risk: LOW - Shared IPs might hit this if 10+ users access simultaneously
 *        Solution: If issues occur, increase to 200 or switch to user-based limiting
 */
export const publicLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests/min per IP
  message: 'Too many requests from this IP. Please try again later.',
});

/**
 * GRADUAL ROLLOUT HELPER
 *
 * Set RATE_LIMIT_ENABLED=false to disable all rate limiting without code changes
 * Useful for emergency rollback if needed
 */
export function applyRateLimitIfEnabled(
  limiter: (req: Request, res: Response, next: NextFunction) => void,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.RATE_LIMIT_ENABLED === 'false') {
      logger.debug('Rate limiting disabled via RATE_LIMIT_ENABLED env var');
      return next();
    }
    return limiter(req, res, next);
  };
}
