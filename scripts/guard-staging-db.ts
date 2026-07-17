#!/usr/bin/env npx tsx
/**
 * Allows migrate/seed against a hosted **staging** database (J2).
 * Never use for production — requires explicit acknowledgement.
 *
 * Usage (from backend/):
 *   STAGING_DATABASE_ACK=1 npm run prisma:seed-sandbox-staging
 *
 * Optional safety: set PRODUCTION_DATABASE_URL — bootstrap refuses if it matches DATABASE_URL.
 */
import path from "path";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function main(): void {
  if (process.env.STAGING_DATABASE_ACK !== "1") {
    console.error("");
    console.error("❌ BLOCKED: staging database guard requires STAGING_DATABASE_ACK=1");
    console.error("");
    console.error("   This script is for hosted **staging** Neon/Render databases only.");
    console.error("   For local work use: npm run guard:local-db");
    console.error("");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("❌ DATABASE_URL is not set.");
    process.exit(1);
  }

  const prodUrl = process.env.PRODUCTION_DATABASE_URL?.trim();
  if (prodUrl && normalizeUrl(prodUrl) === normalizeUrl(url)) {
    console.error("");
    console.error("❌ BLOCKED: DATABASE_URL matches PRODUCTION_DATABASE_URL.");
    console.error("   Use a Neon branch or separate staging database.");
    console.error("");
    process.exit(1);
  }

  const lower = url.toLowerCase();
  if (
    !lower.includes("staging") &&
    !lower.includes("branch") &&
    process.env.STAGING_HOST_OK !== "1"
  ) {
    console.warn(
      "⚠️  DATABASE_URL hostname does not contain 'staging' or 'branch'.",
    );
    console.warn("   Confirm this is a disposable staging DB, not production.");
    console.warn("   Set STAGING_HOST_OK=1 to proceed anyway.");
    process.exit(1);
  }

  console.log("✓ Staging database guard passed (STAGING_DATABASE_ACK=1)");
}

main();
