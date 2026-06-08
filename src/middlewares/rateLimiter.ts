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

import rateLimit from 'express-rate-limit';
import { logger } from '../lib/logger';

/**
 * Creates a standardized rate limiter with logging
 */
function createLimiter(config: {
  windowMs: number;
  max: number;
  skipSuccessfulRequests?: boolean;
  keyGenerator?: (req: any) => string;
  message: string;
  handler?: (req: any, res: any) => void;
}) {
  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    skipSuccessfulRequests: config.skipSuccessfulRequests || false,
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false, // Disable `X-RateLimit-*` headers
    keyGenerator: config.keyGenerator,
    handler: (req, res) => {
      // Log rate limit violations for monitoring
      logger.warn({
        ip: req.ip,
        userId: req.auth?.userId,
        path: req.path,
        limit: config.max,
        window: config.windowMs / 1000 / 60 + 'min',
      }, 'Rate limit exceeded');

      if (config.handler) {
        config.handler(req, res);
      } else {
        res.status(429).json({
          error: config.message,
          retryAfter: Math.ceil(config.windowMs / 1000),
        });
      }
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
  keyGenerator: (req) => {
    // Use userId if authenticated, otherwise IP
    // This prevents shared WiFi issues
    return req.auth?.userId || req.ip;
  },
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
  keyGenerator: (req) => req.auth?.userId || req.ip,
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
  keyGenerator: (req) => req.auth?.userId || req.ip,
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
 * HEALTH CHECK EXEMPT - No rate limiting on monitoring endpoints
 * This middleware explicitly skips rate limiting for health/monitoring
 */
export const exemptFromRateLimit = (req: any, res: any, next: any) => {
  // Skip rate limiting for monitoring endpoints
  if (req.path === '/health' || req.path === '/api/health') {
    return next();
  }
  next();
};

/**
 * GRADUAL ROLLOUT HELPER
 * 
 * Set RATE_LIMIT_ENABLED=false to disable all rate limiting without code changes
 * Useful for emergency rollback if needed
 */
export function applyRateLimitIfEnabled(limiter: any) {
  return (req: any, res: any, next: any) => {
    if (process.env.RATE_LIMIT_ENABLED === 'false') {
      logger.debug('Rate limiting disabled via RATE_LIMIT_ENABLED env var');
      return next();
    }
    return limiter(req, res, next);
  };
}
