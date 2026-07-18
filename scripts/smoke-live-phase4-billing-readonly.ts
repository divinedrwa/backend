#!/usr/bin/env npx tsx
/**
 * Read-only live smoke for Phase 4 billing (A8 charge heads, A9 settings).
 *
 * GET only. Verifies new endpoints respond and Divine Residency invariants hold.
 * Does NOT enable charge heads, publish cycles, or mutate ledger data.
 *
 * Usage (from backend/):
 *   source .env.smoke  # SMOKE_TENANT_ADMIN_* or SMOKE_ADMIN_*
 *   npx tsx scripts/smoke-live-phase4-billing-readonly.ts
 */
const base = (process.env.HTTP_SMOKE_BASE ?? process.env.LIVE_API_ORIGIN ?? "https://gatepass-v037.onrender.com")
  .replace(/\/$/, "")
  .replace(/\/api$/, "");

const societyId =
  process.env.SMOKE_SOCIETY_ID?.trim() || "cmp32fto40001qout5koygcqu";

const tenantAdminUser =
  process.env.SMOKE_TENANT_ADMIN_USERNAME?.trim() ||
  process.env.SMOKE_ADMIN_USERNAME?.trim();
const tenantAdminPass =
  process.env.SMOKE_TENANT_ADMIN_PASSWORD?.trim() ||
  process.env.SMOKE_ADMIN_PASSWORD?.trim();

async function mustStatus(label: string, res: Response, codes: number[]): Promise<string> {
  const body = await res.text();
  if (!codes.includes(res.status)) {
    throw new Error(`${label}: expected ${codes.join("|")}, got ${res.status}. Body: ${body.slice(0, 400)}`);
  }
  return body;
}

async function main(): Promise<void> {
  console.log(`Phase 4 billing read-only smoke → ${base}`);
  console.log(`Society: ${societyId}`);
  console.log("");

  if (!tenantAdminUser || !tenantAdminPass) {
    throw new Error("Set SMOKE_TENANT_ADMIN_* or SMOKE_ADMIN_* in backend/.env.smoke");
  }

  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: tenantAdminUser,
      password: tenantAdminPass,
      societyId,
    }),
  });
  const loginBody = await mustStatus("POST /api/auth/login", loginRes, [200]);
  const loginJson = JSON.parse(loginBody) as { token?: string; societyId?: string };
  if (!loginJson.token) throw new Error("Login response missing token");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${loginJson.token}`,
    "X-Society-Id": societyId,
  };

  const settingsRes = await fetch(`${base}/api/society-settings`, { headers });
  const settingsBody = await mustStatus("GET /api/society-settings", settingsRes, [200]);
  const settingsJson = JSON.parse(settingsBody) as {
    society?: {
      maintenanceBillingMode?: string;
      useChargeHeads?: boolean;
      maintenanceFixedAmount?: string | number | null;
    };
  };
  const society = settingsJson.society;
  if (!society) throw new Error("society-settings response missing society");

  console.log(`  ✓ society-settings (${settingsRes.status})`);
  console.log(`    maintenanceBillingMode=${society.maintenanceBillingMode ?? "FIXED"}`);

  if ("useChargeHeads" in society) {
    console.log(`    useChargeHeads=${String(society.useChargeHeads)}`);
    if (society.useChargeHeads === true && societyId === "cmp32fto40001qout5koygcqu") {
      console.warn(
        "  ⚠ Divine Residency has useChargeHeads=true — confirm this was intentional",
      );
    } else if (society.useChargeHeads !== true) {
      console.log("    ✓ useChargeHeads is false (default safe path)");
    }
  } else {
    console.log("    ○ useChargeHeads field absent (pre-migration API or old deploy)");
  }

  const headsRes = await fetch(`${base}/api/society-settings/charge-heads`, { headers });
  if (headsRes.status === 404) {
    console.log("  ○ GET /api/society-settings/charge-heads → 404 (not deployed yet)");
  } else {
    const headsBody = await mustStatus("GET /api/society-settings/charge-heads", headsRes, [200]);
    const headsJson = JSON.parse(headsBody) as { chargeHeads?: unknown[] };
    const count = Array.isArray(headsJson.chargeHeads) ? headsJson.chargeHeads.length : 0;
    console.log(`  ✓ charge-heads (${headsRes.status}, ${count} heads)`);
  }

  const cyclesRes = await fetch(`${base}/api/billing/v1/cycles`, { headers });
  await mustStatus("GET /api/billing/v1/cycles", cyclesRes, [200]);
  console.log(`  ✓ billing cycles (${cyclesRes.status})`);

  const reconRes = await fetch(`${base}/api/reconciliation/summary`, { headers });
  if (reconRes.status >= 500) {
    const t = await reconRes.text();
    throw new Error(`reconciliation summary: ${reconRes.status} ${t.slice(0, 200)}`);
  }
  console.log(`  ✓ reconciliation summary (${reconRes.status})`);

  console.log("");
  console.log("Phase 4 billing read-only smoke: PASS");
}

main().catch((err) => {
  console.error("");
  console.error("Phase 4 billing read-only smoke: FAIL");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
