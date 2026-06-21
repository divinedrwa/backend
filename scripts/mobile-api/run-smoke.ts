#!/usr/bin/env npx tsx
/**
 * Smoke-test every REST endpoint consumed by divine_app (Flutter).
 *
 * Usage (from backend/, API must be running):
 *   npm run smoke:mobile-apis
 *   MOBILE_SMOKE_BASE=https://gatepass-v037.onrender.com npm run smoke:mobile-apis
 *
 * Credentials (defaults match QA seed / minimal seed):
 *   MOBILE_SMOKE_SOCIETY_ID     — optional; first ACTIVE society if omitted
 *   MOBILE_SMOKE_RESIDENT_USER  — default resident1
 *   MOBILE_SMOKE_RESIDENT_PASS  — default resident123
 *   MOBILE_SMOKE_GUARD_USER     — default guard1
 *   MOBILE_SMOKE_GUARD_PASS     — default guard123
 *   MOBILE_SMOKE_ADMIN_USER     — default admin
 *   MOBILE_SMOKE_ADMIN_PASS     — default ChangeMe123!
 *
 * Exit code 1 when any required case fails (HTTP 500 or unexpected status).
 */

import { MOBILE_API_CASES, MOBILE_API_MUTATION_CASES } from "./manifest";
import { mustHealth, tenantLogin, fetchPublicSocieties, runApiCase } from "./http";
import type { LoginFailure } from "./http";
import { prefetchIds } from "./prefetch-ids";
import type { SmokeContext, SmokeResult, SmokeTokens } from "./types";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : fallback;
}

function baseOrigin(): string {
  const raw =
    env("MOBILE_SMOKE_BASE") ??
    env("HTTP_SMOKE_BASE") ??
    "http://127.0.0.1:4000";
  return raw.replace(/\/$/, "").replace(/\/api$/, "");
}

function printResult(r: SmokeResult): void {
  if (r.skipped) {
    console.log(`  ○ SKIP ${r.method} ${r.path} [${r.role}] — ${r.reason}`);
    return;
  }
  const mark = r.ok ? "✓" : "✗";
  const detail = r.ok ? `${r.status}` : `${r.status} ${r.bodyPreview ?? ""}`;
  console.log(`  ${mark} ${r.method} ${r.path} [${r.role}] — ${detail}`);
}

async function loginAll(
  baseUrl: string,
  societyId: string,
): Promise<{ tokens: SmokeTokens; warnings: string[] }> {
  const tokens: SmokeTokens = {};
  const warnings: string[] = [];

  const residentUser = env("MOBILE_SMOKE_RESIDENT_USER", "resident1")!;
  const residentPass = env("MOBILE_SMOKE_RESIDENT_PASS", "resident123")!;
  const guardUser = env("MOBILE_SMOKE_GUARD_USER", "guard1")!;
  const guardPass = env("MOBILE_SMOKE_GUARD_PASS", "guard123")!;
  const adminUser = env("MOBILE_SMOKE_ADMIN_USER", env("SMOKE_ADMIN_USERNAME", "admin"))!;
  const adminPass = env(
    "MOBILE_SMOKE_ADMIN_PASS",
    env("SMOKE_ADMIN_PASSWORD", env("ADMIN_PASSWORD", "ChangeMe123!")),
  )!;

  const resident = await tenantLogin(baseUrl, societyId, residentUser, residentPass);
  if (isLoginResult(resident)) {
    tokens.resident = resident.token;
    console.log(`  ✓ resident login (${residentUser}, role=${resident.role})`);
  } else {
    warnings.push(`resident login failed for ${residentUser}: ${resident.message}`);
    console.warn(`  ⚠ resident login failed (${residentUser}): ${resident.message}`);
  }

  const guard = await tenantLogin(baseUrl, societyId, guardUser, guardPass);
  if (isLoginResult(guard)) {
    tokens.guard = guard.token;
    console.log(`  ✓ guard login (${guardUser}, role=${guard.role})`);
  } else {
    warnings.push(`guard login failed for ${guardUser}: ${guard.message}`);
    console.warn(`  ⚠ guard login failed (${guardUser}): ${guard.message}`);
  }

  const admin = await tenantLogin(baseUrl, societyId, adminUser, adminPass);
  if (isLoginResult(admin)) {
    tokens.admin = admin.token;
    console.log(`  ✓ admin login (${adminUser}, role=${admin.role})`);
  } else {
    warnings.push(`admin login failed for ${adminUser}: ${admin.message}`);
    console.warn(`  ⚠ admin login failed (${adminUser}): ${admin.message}`);
  }

  return { tokens, warnings };
}

function isLoginResult(r: { token: string } | LoginFailure): r is { token: string; societyId: string; role: string } {
  return "token" in r;
}

async function main(): Promise<void> {
  const baseUrl = baseOrigin();
  console.log(`Mobile API smoke → ${baseUrl}`);

  await mustHealth(baseUrl);
  console.log("  ✓ GET /health");

  const societies = await fetchPublicSocieties(baseUrl);
  const societyId = env("MOBILE_SMOKE_SOCIETY_ID", env("SMOKE_SOCIETY_ID")) ?? societies[0]?.id;
  if (!societyId) {
    throw new Error("No society id — set MOBILE_SMOKE_SOCIETY_ID or seed a society");
  }
  console.log(`  ✓ society ${societyId}`);

  console.log("\nAuth:");
  const { tokens, warnings } = await loginAll(baseUrl, societyId);

  const hasAnyToken = Boolean(tokens.resident || tokens.guard || tokens.admin);
  if (!hasAnyToken) {
    console.error(
      "\nNo tenant logins succeeded — authenticated API cases were skipped.\n" +
        "Run: npm run sync:qa-credentials   (or set MOBILE_SMOKE_*_USER/PASS env vars)\n",
    );
    process.exit(1);
  }
  if (warnings.length > 0) {
    console.warn(`\n  (${warnings.length} login warning(s) — some roles will be skipped)`);
  }

  const ctx: SmokeContext = {
    baseUrl,
    societyId,
    tokens,
    ids: {},
  };

  console.log("\nPrefetching dynamic ids…");
  ctx.ids = await prefetchIds(ctx);
  const idKeys = Object.entries(ctx.ids).filter(([, v]) => v).map(([k]) => k);
  console.log(`  ids: ${idKeys.length ? idKeys.join(", ") : "(none)"}`);

  const results: SmokeResult[] = [];

  console.log(`\nGET smoke (${MOBILE_API_CASES.length} cases)…`);
  for (const apiCase of MOBILE_API_CASES) {
    for (const role of apiCase.roles) {
      const r = await runApiCase(baseUrl, ctx, apiCase, role);
      results.push(r);
      printResult(r);
    }
  }

  console.log(`\nMutation smoke (${MOBILE_API_MUTATION_CASES.length} cases)…`);
  for (const apiCase of MOBILE_API_MUTATION_CASES) {
    if (apiCase.name.includes("logout")) continue;
    for (const role of apiCase.roles) {
      const r = await runApiCase(baseUrl, ctx, apiCase, role);
      results.push(r);
      printResult(r);
    }
  }

  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.ok);
  const failed = ran.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);

  console.log("\n── Summary ──");
  console.log(`  passed:  ${passed.length}`);
  console.log(`  failed:  ${failed.length}`);
  console.log(`  skipped: ${skipped.length}`);

  if (failed.length > 0) {
    console.error("\nFailures:");
    for (const f of failed) {
      console.error(`  • ${f.name} [${f.role}] ${f.method} ${f.path} → ${f.status} ${f.reason ?? f.bodyPreview ?? ""}`);
    }
    process.exit(1);
  }

  console.log("\nAll required mobile API smoke checks passed.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
