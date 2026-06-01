import "./config/env";
import crypto from "crypto";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import path from "path";
import pinoHttp from "pino-http";
import routes from "./routes";
import swaggerRoutes from "./routes/swagger";
import { errorHandler } from "./middlewares/error";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { billingPaymentWebhookHandler } from "./modules/billing-cycle/billing-webhook";
import { phonePeCallbackHandler } from "./modules/billing-cycle/phonepe-webhook";

export const app = express();

// Trust the first proxy hop so express-rate-limit and similar middlewares
// see the client IP (not the proxy's) when deployed behind nginx/Vercel/Render.
app.set("trust proxy", 1);

// Security headers. CSP is left at helmet's default (off) because this
// process serves an API + uploads; HTML responses come from the Next app.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

/**
 * CORS allow-list. Set CORS_ORIGINS to a comma-separated list of origins
 * in any non-development environment, e.g.:
 *   CORS_ORIGINS=https://admin.example.com,https://www.example.com
 * If unset, falls back to allow-all (dev convenience). Never leave it
 * unset in production — the API serves bearer-authenticated endpoints.
 */
const corsAllowList = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Optional: Vercel project slug for matching preview-deploy origins.
 * Set VERCEL_PROJECT_SLUG (e.g. "divinedrwa-2575s-projects") and all
 * `https://<deployment>-<slug>.vercel.app` origins are accepted automatically
 * so you don't need to update CORS_ORIGINS on every preview push.
 */
const vercelSlug = (process.env.VERCEL_PROJECT_SLUG ?? "").trim();

/**
 * Optional: Firebase project ID for auto-allowing Firebase Hosting origins.
 * Set FIREBASE_PROJECT_ID (e.g. "society-e1a2e") and both
 * `https://<id>.web.app` and `https://<id>.firebaseapp.com` are accepted.
 */
const firebaseProjectId = (process.env.FIREBASE_PROJECT_ID ?? "").trim();

if (corsAllowList.length === 0 && !vercelSlug && !firebaseProjectId && process.env.NODE_ENV === "production") {
  logger.error(
    "CORS_ORIGINS is not set in production — defaulting to restrictive CORS (no cross-origin allowed). " +
    "Set CORS_ORIGINS to a comma-separated allow-list of origins (e.g. https://admin.example.com)."
  );
}

function corsOriginCheck(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
) {
  // Allow requests with no origin (server-to-server, curl, mobile apps)
  if (!origin) return callback(null, true);

  // Exact match against allow-list
  if (corsAllowList.includes(origin)) return callback(null, true);

  // Vercel preview deployments: https://<anything>-<slug>.vercel.app
  if (vercelSlug && origin.endsWith(`-${vercelSlug}.vercel.app`) && origin.startsWith("https://")) {
    return callback(null, true);
  }

  // Firebase Hosting: https://<project-id>.web.app and .firebaseapp.com
  if (firebaseProjectId) {
    if (
      origin === `https://${firebaseProjectId}.web.app` ||
      origin === `https://${firebaseProjectId}.firebaseapp.com`
    ) {
      return callback(null, true);
    }
  }

  callback(null, false);
}

app.use(
  cors({
    origin:
      corsAllowList.length > 0 || vercelSlug || firebaseProjectId
        ? corsOriginCheck
        : process.env.NODE_ENV === "production"
          ? false
          : true,
  })
);

// Global rate limit: 100 requests per minute per IP. Stricter per-route
// limits on /auth/login and /auth/register still apply on top of this.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message: "Too many requests, please try again later" },
  })
);

// Request ID: propagate incoming X-Request-Id or generate a new UUID.
// Attached to every log line via pino-http's `genReqId` and echoed
// back in the response header for client-side correlation.
app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const existing = req.headers["x-request-id"];
      const id = (typeof existing === "string" && existing) || crypto.randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
    autoLogging: { ignore: (req) => req.url === "/health" },
  })
);

// Tighter rate limit for payment webhooks — public endpoints hit by
// gateway servers. 30 requests per minute per IP is generous for
// legitimate callbacks but stops abuse from burning DB queries.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many webhook requests" },
});

app.post(
  "/api/v1/payments/webhook",
  webhookLimiter,
  express.raw({ type: "*/*", limit: "2mb" }),
  async (req, res, next) => {
    try {
      await billingPaymentWebhookHandler(req, res);
    } catch (e) {
      next(e);
    }
  }
);

// Hard cap on JSON body size. Profile-image and attachment uploads go
// through dedicated multipart endpoints with their own limits.
app.use(express.json({ limit: "1mb" }));

// PhonePe callback: mounted after express.json() since PhonePe sends JSON
app.post("/api/v1/payments/phonepe/callback", webhookLimiter, async (req, res, next) => {
  try {
    await phonePeCallbackHandler(req, res);
  } catch (e) {
    next(e);
  }
});

/** Profile avatars saved under `uploads/avatars` — URL path `/uploads/...` (same origin as API port). */
app.use("/uploads", (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
}, express.static(path.join(process.cwd(), "uploads")));

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: true });
  } catch {
    res.status(503).json({ ok: false, db: false });
  }
});

/**
 * Compatibility: some clients call `/auth/...`, `/public/...`, or `/super/...` without the `/api` prefix.
 * Rewrites to `/api/...` so routes still match (same router as `app.use("/api", routes)`).
 */
app.use((req, _res, next) => {
  const p = req.path ?? "";
  const needsApiPrefix =
    p === "/auth" ||
    p.startsWith("/auth/") ||
    p === "/public" ||
    p.startsWith("/public/") ||
    p === "/super" ||
    p.startsWith("/super/");
  if (needsApiPrefix) {
    req.url = `/api${req.url}`;
  }
  next();
});

// Log slow requests (>500ms) at warn level for performance monitoring
const SLOW_REQUEST_MS = 500;
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (durationMs > SLOW_REQUEST_MS) {
      logger.warn({ method: req.method, path: req.originalUrl, durationMs: Math.round(durationMs), status: res.statusCode }, "slow request");
    }
  });
  next();
});

if (process.env.NODE_ENV !== "production") {
  app.use("/api", swaggerRoutes);
}
app.use("/api", routes);
app.use(errorHandler);
