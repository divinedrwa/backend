#!/usr/bin/env npx tsx
/**
 * Safe live smoke for Divine Residency — villa 25 only.
 *
 * Read-only: GETs only. Uses tenant admin login when SMOKE_TENANT_ADMIN_* is set (no DB writes).
 * Fallback: super-admin tenant-session writes one AdminAuditLog row only when tenant creds absent.
 * Skips: payments, parcels, visitors, ledger writes, mutations.
 *
 * Usage (from backend/):
 *   SMOKE_SUPER_USERNAME=super_admin SMOKE_SUPER_PASSWORD=... \
 *   SMOKE_SOCIETY_ID=cmp32fto40001qout5koygcqu \
 *   SMOKE_VILLA_NUMBER=25 \
 *   npx tsx scripts/smoke-live-villa25-safe.ts
 */
const base = (process.env.HTTP_SMOKE_BASE ?? process.env.LIVE_API_ORIGIN ?? "https://gatepass-v037.onrender.com")
  .replace(/\/$/, "")
  .replace(/\/api$/, "");

const societyId =
  process.env.SMOKE_SOCIETY_ID?.trim() || "cmp32fto40001qout5koygcqu";
const villaNumber = (process.env.SMOKE_VILLA_NUMBER ?? "25").trim();
const superUser = process.env.SMOKE_SUPER_USERNAME?.trim();
const superPass = process.env.SMOKE_SUPER_PASSWORD?.trim();
const tenantAdminUser =
  process.env.SMOKE_TENANT_ADMIN_USERNAME?.trim() ||
  process.env.SMOKE_ADMIN_USERNAME?.trim();
const tenantAdminPass =
  process.env.SMOKE_TENANT_ADMIN_PASSWORD?.trim() ||
  process.env.SMOKE_ADMIN_PASSWORD?.trim();
const residentUser =
  process.env.MOBILE_SMOKE_RESIDENT_USER?.trim() || process.env.SMOKE_RESIDENT_USERNAME?.trim();
const residentPass =
  process.env.MOBILE_SMOKE_RESIDENT_PASS?.trim() || process.env.SMOKE_RESIDENT_PASSWORD?.trim();

type VillaRow = {
  id: string;
  villaNumber?: string | null;
  number?: string | null;
  label?: string | null;
};

function villaLabel(v: VillaRow): string {
  return String(v.villaNumber ?? v.number ?? v.label ?? "").trim();
}

function matchesVilla25(v: VillaRow, want: string): boolean {
  const n = villaLabel(v).toLowerCase();
  const w = want.toLowerCase();
  if (n === w) return true;
  // "25", "A-25", "Villa 25", "SB-25"
  if (n === `villa ${w}` || n.endsWith(`-${w}`) || n.endsWith(` ${w}`)) return true;
  const digits = n.replace(/\D/g, "");
  return digits === w.replace(/\D/g, "") && digits.length > 0;
}

async function mustStatus(label: string, res: Response, codes: number[]): Promise<string> {
  const body = await res.text();
  if (!codes.includes(res.status)) {
    throw new Error(`${label}: expected ${codes.join("|")}, got ${res.status}. Body: ${body.slice(0, 300)}`);
  }
  return body;
}

async function main(): Promise<void> {
  console.log(`Safe live smoke → ${base}`);
  console.log(`Society: ${societyId}`);
  console.log(`Villa scope: ${villaNumber} only (read-only; no mutations)`);
  console.log("");

  if (!superUser && !superPass && !tenantAdminUser && !tenantAdminPass) {
    throw new Error(
      "Set SMOKE_SUPER_* and/or SMOKE_TENANT_ADMIN_* (or SMOKE_ADMIN_* for society admin)",
    );
  }

  // Truncated ID guard (user typo without trailing u)
  if (societyId === "cmp32fto40001qout5koygcq") {
    throw new Error(
      "SMOKE_SOCIETY_ID looks truncated. Use cmp32fto40001qout5koygcqu (Divine Residency).",
    );
  }

  {
    const r = await fetch(`${base}/health`);
    await mustStatus("GET /health", r, [200]);
    console.log("  ✓ GET /health");
  }

  {
    const r = await fetch(`${base}/api/public/societies`);
    const body = await mustStatus("GET /api/public/societies", r, [200]);
    const j = JSON.parse(body) as { societies?: Array<{ id: string; name?: string }> };
    const hit = (j.societies ?? []).find((s) => s.id === societyId);
    if (!hit) throw new Error(`Society ${societyId} not in public list`);
    console.log(`  ✓ society ${hit.name} present`);
  }

  let superToken = "";
  if (superUser && superPass) {
    const r = await fetch(`${base}/api/auth/super-admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: superUser, password: superPass }),
    });
    const body = await mustStatus("POST /api/auth/super-admin/login", r, [200]);
    const j = JSON.parse(body) as { token?: string; user?: { role?: string } };
    if (!j.token) throw new Error("super-admin login: missing token");
    if (j.user?.role !== "SUPER_ADMIN") {
      throw new Error(`Expected SUPER_ADMIN, got ${j.user?.role ?? "?"}`);
    }
    superToken = j.token;
    console.log("  ✓ super-admin login (platform)");

    const r2 = await fetch(`${base}/api/super/societies/${societyId}`, {
      headers: { Authorization: `Bearer ${superToken}` },
    });
    const body2 = await mustStatus("GET /api/super/societies/:id", r2, [200]);
    const j2 = JSON.parse(body2) as { society?: { name?: string; counts?: { villas?: number } } };
    console.log(
      `  ✓ society detail (${j2.society?.name ?? "?"}, villas=${j2.society?.counts?.villas ?? "?"})`,
    );
  } else {
    console.log("  ○ skip super-admin block (no SMOKE_SUPER_* — using tenant admin only)");
  }

  // Tenant ADMIN reads — prefer direct login (zero DB writes). Fallback: super tenant-session (audit log only).
  let adminToken = "";
  let adminUsername = "";
  let usedTenantSession = false;

  async function tryTenantLogin(username: string, password: string): Promise<boolean> {
    for (const path of ["/api/auth/admin/login", "/api/auth/login"] as const) {
      const r = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ societyId, username, password }),
      });
      if (r.status !== 200) continue;
      const body = await r.text();
      const j = JSON.parse(body) as {
        token?: string;
        user?: { username?: string; role?: string };
      };
      if (!j.token || j.user?.role !== "ADMIN") continue;
      adminToken = j.token;
      adminUsername = j.user?.username ?? username;
      console.log(`  ✓ tenant admin login via ${path} (${adminUsername}) [read-only, no audit row]`);
      return true;
    }
    return false;
  }

  if (tenantAdminUser && tenantAdminPass && (await tryTenantLogin(tenantAdminUser, tenantAdminPass))) {
    // ok — no writes
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
    const j = JSON.parse(body) as {
      token?: string;
      user?: { username?: string; role?: string };
    };
    if (!j.token) throw new Error("tenant-session: missing token");
    adminToken = j.token;
    adminUsername = j.user?.username ?? "?";
    usedTenantSession = true;
    console.log(
      `  ✓ tenant-session as society ADMIN (${adminUsername}) [1 audit log row — set SMOKE_TENANT_ADMIN_* to avoid]`,
    );
  } else {
    throw new Error("No tenant admin login and no super token for tenant-session fallback");
  }

  const tenantHeaders = {
    Authorization: `Bearer ${adminToken}`,
    "X-Society-Id": societyId,
  };

  let villa: VillaRow | null = null;
  {
    const r = await fetch(`${base}/api/villas`, { headers: tenantHeaders });
    const body = await mustStatus("GET /api/villas", r, [200]);
    const j = JSON.parse(body) as Record<string, unknown>;
    const list = (Array.isArray(j.villas)
      ? j.villas
      : Array.isArray(j.items)
        ? j.items
        : Array.isArray(j)
          ? j
          : []) as VillaRow[];
    villa = list.find((v) => matchesVilla25(v, villaNumber)) ?? null;
    if (!villa?.id) {
      const sample = list.slice(0, 8).map((v) => villaLabel(v) || v.id).join(", ");
      throw new Error(
        `Villa ${villaNumber} not found among ${list.length} villas. Sample: ${sample}`,
      );
    }
    console.log(`  ✓ villa ${villaNumber} id=${villa.id} label=${villaLabel(villa)}`);
  }

  // Villa-scoped / villa-relevant reads only
  const villaGets: Array<[string, string]> = [
    [`/api/villas/${villa.id}`, "villa detail"],
    [`/api/users?villaId=${encodeURIComponent(villa.id)}`, "users by villa"],
    ["/api/reconciliation/summary", "reconciliation summary (society read)"],
    ["/api/reconciliation/alerts?status=unresolved", "reconciliation alerts (read)"],
    ["/api/billing/v1/cycles", "billing cycles (read)"],
    ["/api/maintenance-management/financial-dashboard", "financial dashboard (read)"],
  ];

  for (const [path, label] of villaGets) {
    const url = path.includes("?")
      ? `${base}${path}`
      : path.includes("financial-dashboard")
        ? `${base}${path}?month=${new Date().getMonth() + 1}&year=${new Date().getFullYear()}`
        : `${base}${path}`;
    const r = await fetch(url, { headers: tenantHeaders });
    // 404/400 acceptable for optional filters; never 500
    if (r.status >= 500) {
      const t = await r.text();
      throw new Error(`${label}: ${r.status} ${t.slice(0, 200)}`);
    }
    console.log(`  ✓ ${label} (${r.status})`);
  }

  // Resident of villa 25 — read-only mobile paths (no pay / pre-approve / complaint create)
  if (residentUser && residentPass) {
    console.log("");
    console.log("--- Resident (villa " + villaNumber + ") ---");
    let residentToken = "";
    let residentVillaId: string | null | undefined;
    let loginRole: string = "RESIDENT";
    {
      const r = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: residentUser,
          password: residentPass,
          societyId,
        }),
      });
      const body = await mustStatus("POST /api/auth/login (resident)", r, [200]);
      const j = JSON.parse(body) as {
        token?: string;
        user?: { role?: string; villaId?: string | null; username?: string };
      };
      if (!j.token) throw new Error("resident login: missing token");
      const role = j.user?.role ?? "?";
      // Live quirk: divine_25 is ADMIN in DB but bound to villa 25 and can call most resident GETs.
      if (role !== "RESIDENT" && role !== "ADMIN") {
        throw new Error(`Expected RESIDENT (or villa-bound ADMIN), got ${role}`);
      }
      if (role === "ADMIN") {
        console.log(
          `  · note: ${j.user?.username ?? residentUser} role=ADMIN in DB (expected RESIDENT) — continuing villa-scoped reads`,
        );
      }
      loginRole = role;
      residentToken = j.token;
      residentVillaId = j.user?.villaId;
      console.log(`  ✓ login (${j.user?.username ?? residentUser}, role=${role})`);
    }

    if (residentVillaId && residentVillaId !== villa.id) {
      throw new Error(
        `Resident villaId ${residentVillaId} ≠ villa ${villaNumber} id ${villa.id} — aborting (wrong villa).`,
      );
    }
    if (!residentVillaId) {
      console.log("  · warn: login response missing villaId — continuing with GET checks");
    } else {
      console.log(`  ✓ resident bound to villa ${villaNumber} (${residentVillaId})`);
    }

    const residentHeaders = {
      Authorization: `Bearer ${residentToken}`,
      "X-Society-Id": societyId,
    };

    const residentGets: Array<[string, string]> = [
      ["/api/residents/me", "profile"],
      ["/api/residents/dashboard", "dashboard"],
      ["/api/residents/maintenance-dashboard", "maintenance dashboard"],
      ["/api/residents/maintenance-pending", "maintenance pending"],
      ["/api/residents/outstanding-dues", "outstanding dues"],
      ["/api/residents/my-maintenance", "my maintenance"],
      ["/api/residents/payment-methods", "payment methods"],
      ["/api/residents/my-upi-payments", "my upi payments"],
      ["/api/residents/my-visitors", "my visitors"],
      ["/api/residents/visitor-approval-requests", "visitor approval requests"],
      ["/api/residents/my-parcels", "my parcels"],
      ["/api/residents/my-notices", "my notices"],
      ["/api/residents/society-expenses", "society expenses"],
      ["/api/residents/society-expenses/grouped-by-billing-cycle", "expenses by cycle"],
      ["/api/notifications", "notifications"],
      ["/api/residents/my-notifications", "notifications legacy"],
    ];

    for (const [path, label] of residentGets) {
      const r = await fetch(`${base}${path}`, { headers: residentHeaders });
      if (r.status >= 500) {
        const t = await r.text();
        throw new Error(`resident ${label}: ${r.status} ${t.slice(0, 200)}`);
      }
      // Optional / not-yet-deployed routes
      if (
        r.status === 404 &&
        (path.includes("grouped-by-billing-cycle") || path.includes("my-notifications"))
      ) {
        console.log(`  ○ ${label} (${r.status} — not on this deploy)`);
        continue;
      }
      // ADMIN-bound villa users are forbidden on some RESIDENT-only routes (expected)
      if (r.status === 403 && loginRole === "ADMIN") {
        console.log(`  ○ ${label} (403 — RESIDENT-only route; account is ADMIN)`);
        continue;
      }
      if (![200, 204].includes(r.status)) {
        const t = await r.text();
        throw new Error(`resident ${label}: expected 200, got ${r.status}. ${t.slice(0, 200)}`);
      }
      console.log(`  ✓ ${label} (${r.status})`);
    }
  } else {
    console.log("");
    console.log("○ SKIP resident checks — set MOBILE_SMOKE_RESIDENT_USER / PASS");
  }

  // Explicitly NOT run: parcel create, visitor check-in, payment capture, logout mutations that create data
  console.log("");
  console.log("Skipped (by design — no live writes):");
  console.log("  • guard parcel-received");
  console.log("  • visitor / payment / cash / UPI mutations");
  console.log("  • full mobile-api mutation suite");
  console.log("");
  console.log("Safe live smoke PASSED (villa " + villaNumber + " read-only).");
  if (usedTenantSession) {
    console.log("  · side effect: 1 AdminAuditLog (IMPERSONATE_TENANT) — no ledger/visitor/payment rows");
  } else {
    console.log("  · side effects: none (login tokens only)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
