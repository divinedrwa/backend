/**
 * Sentry instrumentation — MUST be imported before any other module
 * so that Sentry's require-hooks can patch Express, Prisma, ioredis, etc.
 */

import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
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
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      return event;
    },
  });

  // eslint-disable-next-line no-console
  console.log(`[Sentry] Initialized (${process.env.NODE_ENV})`);
} else {
  // eslint-disable-next-line no-console
  console.log("[Sentry] Skipped - SENTRY_DSN not configured");
}

export { Sentry };
