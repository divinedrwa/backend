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

  const errors: string[] = [];

  const paymentKey = process.env.PAYMENT_SECRETS_KEY?.trim();
  if (!paymentKey) {
    errors.push("PAYMENT_SECRETS_KEY is required (generate: openssl rand -hex 32)");
  } else if (paymentKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(paymentKey)) {
    errors.push("PAYMENT_SECRETS_KEY must be exactly 64 hex characters");
  }

  if (!process.env.CORS_ORIGINS?.trim()) {
    errors.push("CORS_ORIGINS is required (comma-separated frontend origins)");
  }

  const jwt = process.env.JWT_SECRET?.trim();
  if (!jwt || jwt.length < 32) {
    errors.push("JWT_SECRET must be at least 32 characters");
  }

  if (!process.env.DIRECT_URL?.trim()) {
    logger.warn(
      "DIRECT_URL not set — cron advisory locks use pooled DATABASE_URL. "
        + "Set DIRECT_URL to a direct Supabase connection (port 5432) for reliable cron deduplication.",
    );
  }

  if (!process.env.API_BASE_URL?.trim()) {
    logger.warn("API_BASE_URL not set — payment gateway callback URLs may be misconfigured.");
  }

  if (errors.length > 0) {
    for (const msg of errors) {
      logger.error({ msg }, "Production env validation failed");
    }
    throw new Error(`Production environment misconfigured: ${errors.join("; ")}`);
  }

  logger.info("Production environment validation passed");
}
