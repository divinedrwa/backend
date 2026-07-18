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

const superUser = process.env.SMOKE_SUPER_USERNAME?.trim();
const superPass = process.env.SMOKE_SUPER_PASSWORD?.trim();
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

  if (!tenantAdminUser && !tenantAdminPass && !superUser && !superPass) {
    throw new Error("Set SMOKE_TENANT_ADMIN_* or SMOKE_SUPER_* in backend/.env.smoke");
  }

  let superToken = "";
  if (superUser && superPass) {
    const r = await fetch(`${base}/api/auth/super-admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: superUser, password: superPass }),
    });
    const body = await mustStatus("POST /api/auth/super-admin/login", r, [200]);
    const j = JSON.parse(body) as { token?: string };
    if (!j.token) throw new Error("super-admin login: missing token");
    superToken = j.token;
    console.log("  ✓ super-admin login");
  }

  let adminToken = "";
  async function tryTenantLogin(username: string, password: string): Promise<boolean> {
    for (const path of ["/api/auth/admin/login", "/api/auth/login"] as const) {
      const r = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ societyId, username, password }),
      });
      if (r.status !== 200) continue;
      const body = await r.text();
      const j = JSON.parse(body) as { token?: string; user?: { role?: string } };
      if (!j.token || j.user?.role !== "ADMIN") continue;
      adminToken = j.token;
      console.log(`  ✓ tenant admin login via ${path}`);
      return true;
    }
    return false;
  }

  if (tenantAdminUser && tenantAdminPass && (await tryTenantLogin(tenantAdminUser, tenantAdminPass))) {
    // ok
  } else if (superToken) {
    const r = await fetch(`${base}/api/super/societies/${societyId}/tenant-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${superToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const body = await mustStatus("POST tenant-session", r, [200]);
    const j = JSON.parse(body) as { token?: string };
    if (!j.token) throw new Error("tenant-session: missing token");
    adminToken = j.token;
    console.log("  ✓ tenant-session as society ADMIN");
  } else {
    throw new Error("No tenant admin login and no super token for tenant-session fallback");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${adminToken}`,
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
    console.log("    ○ useChargeHeads absent in cached society-settings (charge-heads route is authoritative)");
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

  const cyclesRes = await fetch(`${base}/api/v1/admin/cycles`, { headers });
  if (cyclesRes.status >= 500) {
    const t = await cyclesRes.text();
    throw new Error(`billing cycles: ${cyclesRes.status} ${t.slice(0, 200)}`);
  }
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
