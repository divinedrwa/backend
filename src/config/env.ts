import dotenv from "dotenv";
import { logger } from "../lib/logger";

dotenv.config();

function mustGet(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export const env = {
  PORT: Number(process.env.PORT ?? 4000),
  DATABASE_URL: mustGet("DATABASE_URL"),
  JWT_SECRET: mustGet("JWT_SECRET"),
};

/**
 * Fail fast in production when payment secrets encryption is not configured.
 * Call once at process startup (server.ts).
 */
export function validateProductionEnv(): void {
  if (process.env.NODE_ENV !== "production") return;

  const paymentKey = process.env.PAYMENT_SECRETS_KEY?.trim();
  if (!paymentKey) {
    throw new Error(
      "PAYMENT_SECRETS_KEY is required in production. "
        + "Generate with: openssl rand -hex 32",
    );
  }
  if (paymentKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(paymentKey)) {
    throw new Error(
      "PAYMENT_SECRETS_KEY must be exactly 64 hex characters (32 bytes). "
        + "Generate with: openssl rand -hex 32",
    );
  }

  if (!process.env.DIRECT_URL?.trim()) {
    logger.warn(
      "DIRECT_URL not set — cron advisory locks use pooled DATABASE_URL. "
        + "Set DIRECT_URL to a non-pooled Neon connection for reliable cron deduplication.",
    );
  }

  if (!process.env.CORS_ORIGINS?.trim()) {
    logger.warn("CORS_ORIGINS not set — production CORS will reject all browser origins.");
  }

  if (!process.env.API_BASE_URL?.trim()) {
    logger.warn("API_BASE_URL not set — payment gateway callback URLs may be misconfigured.");
  }

  logger.info("Production environment validation passed");
}
