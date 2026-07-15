#!/usr/bin/env npx tsx
/**
 * Refuses migrate/seed against remote production-like databases unless explicitly allowed.
 *
 * Usage (from backend/):
 *   npm run guard:local-db
 *
 * Override (conscious remote access — NOT for roadmap QA):
 *   ALLOW_REMOTE_DB=1 npm run prisma:seed-sandbox
 */
import path from "path";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

/** Substrings that indicate a hosted / shared DB — block by default. */
const REMOTE_INDICATORS = [
  "neon.tech",
  "supabase",
  "pooler.supabase",
  "render.com",
  "amazonaws.com",
  "rds.amazonaws",
  "azure",
  "googleapis",
  "elephantsql",
  "cockroachlabs",
  "planetscale",
  "railway.app",
  "fly.io",
  "digitalocean",
];

function parseHostname(databaseUrl: string): string | null {
  try {
    const u = new URL(databaseUrl);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLocalDatabaseUrl(databaseUrl: string): boolean {
  const host = parseHostname(databaseUrl);
  if (!host) return false;
  if (LOCAL_HOSTS.has(host)) return true;
  // Private LAN ranges sometimes used for local Postgres in Docker
  if (host.startsWith("192.168.") || host.startsWith("10.")) return true;
  return false;
}

function looksRemote(databaseUrl: string): boolean {
  const lower = databaseUrl.toLowerCase();
  return REMOTE_INDICATORS.some((needle) => lower.includes(needle));
}

function main(): void {
  if (process.env.ALLOW_REMOTE_DB === "1") {
    console.warn(
      "⚠️  ALLOW_REMOTE_DB=1 — remote database guard skipped. Do not use for Phase 0 QA.",
    );
    return;
  }

  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("❌ DATABASE_URL is not set. Copy backend/.env.local.example → .env.local");
    process.exit(1);
  }

  const host = parseHostname(url) ?? "(unparseable)";
  const local = isLocalDatabaseUrl(url);
  const remoteHint = looksRemote(url);

  if (!local || remoteHint) {
    console.error("");
    console.error("❌ BLOCKED: DATABASE_URL points at a non-local database.");
    console.error(`   Host detected: ${host}`);
    console.error("");
    console.error("   Phase 0 requires a LOCAL Postgres so live/production data is never touched.");
    console.error("   Fix:");
    console.error("     1. Copy backend/.env.local.example → backend/.env.local");
    console.error("     2. Start local Postgres and run: npm run prisma:migrate:local");
    console.error("     3. Seed sandbox: npm run prisma:seed-sandbox");
    console.error("");
    console.error("   Your backend/.env may still point at Supabase/Neon for other work —");
    console.error("   .env.local overrides DATABASE_URL when present (see dotenv in seed scripts).");
    console.error("");
    if (process.env.FORCE_REMOTE_DB_ACK === "I_UNDERSTAND") {
      console.error("   FORCE_REMOTE_DB_ACK is set but ALLOW_REMOTE_DB=1 is still required.");
    }
    process.exit(1);
  }

  console.log(`✓ Local database guard passed (${host})`);
}

main();
