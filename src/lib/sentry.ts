/**
 * Sentry Error Tracking & Performance Monitoring
 * 
 * SETUP INSTRUCTIONS:
 * 1. Sign up at https://sentry.io (free tier: 5,000 errors/month)
 * 2. Create a new project (type: Node.js)
 * 3. Copy your DSN URL
 * 4. Add to .env: SENTRY_DSN=https://xxxxx@sentry.io/xxxxx
 * 5. Deploy and errors will automatically be tracked
 * 
 * FEATURES:
 * - Automatic error capture
 * - Stack traces with source maps
 * - Performance monitoring (10% sampling)
 * - Release tracking
 * - User context
 */

import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  
  if (!dsn) {
    // eslint-disable-next-line no-console
    console.log("[Sentry] Skipped - SENTRY_DSN not configured");
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    
    // Performance Monitoring
    tracesSampleRate: 0.1, // 10% of requests (free tier friendly)
    
    // Profiling
    profilesSampleRate: 0.1, // 10% of transactions
    integrations: [
      nodeProfilingIntegration(),
    ],
    
    // Release tracking
    release: process.env.npm_package_version,
    
    // Filter sensitive data
    beforeSend(event, _hint) {
      // Remove sensitive headers
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      return event;
    },
  });

  // eslint-disable-next-line no-console
  console.log(`[Sentry] Initialized (${process.env.NODE_ENV})`);
}

export { Sentry };
