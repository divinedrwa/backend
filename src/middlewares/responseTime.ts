/**
 * Response Time Monitoring Middleware
 * 
 * Logs slow requests (>1s default) for performance debugging
 */

import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

const SLOW_REQUEST_THRESHOLD_MS = parseInt(process.env.SLOW_REQUEST_THRESHOLD_MS || "1000", 10);

export function responseTimeMonitor(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  
  // Record time on response finish
  res.on("finish", () => {
    const duration = Date.now() - start;
    
    // Log slow requests
    if (duration > SLOW_REQUEST_THRESHOLD_MS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const auth = (req as any).auth;
      logger.warn({
        method: req.method,
        path: req.path,
        duration,
        statusCode: res.statusCode,
        userId: auth?.userId,
        societyId: auth?.societyId,
      }, `Slow request: ${req.method} ${req.path} took ${duration}ms`);
    }
  });
  
  next();
}
