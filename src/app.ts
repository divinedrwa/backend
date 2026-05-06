import "./config/env";
import cors from "cors";
import express from "express";
import path from "path";
import routes from "./routes";
import { errorHandler } from "./middlewares/error";
import { billingPaymentWebhookHandler } from "./modules/billing-cycle/billing-webhook";

export const app = express();

app.use(cors());

app.post(
  "/api/v1/payments/webhook",
  express.raw({ type: "*/*", limit: "2mb" }),
  async (req, res, next) => {
    try {
      await billingPaymentWebhookHandler(req, res);
    } catch (e) {
      next(e);
    }
  }
);

app.use(express.json());

/** Profile avatars saved under `uploads/avatars` — URL path `/uploads/...` (same origin as API port). */
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
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

app.use("/api", routes);
app.use(errorHandler);
