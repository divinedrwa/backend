#!/usr/bin/env npx tsx
/**
 * Deep read-only live review — post-deploy regression sweep.
 * No mutations except login (tokens only).
 */
const base = (
  process.env.HTTP_SMOKE_BASE ??
  process.env.LIVE_API_ORIGIN ??
  "https://gatepass-v037.onrender.com"
)
  .replace(/\/$/, "")
  .replace(/\/api$/, "");

const societyId =
  process.env.SMOKE_SOCIETY_ID?.trim() || "cmp32fto40001qout5koygcqu";

type Row = { area: string; check: string; result: "PASS" | "FAIL" | "WARN" | "SKIP"; notes: string };
const rows: Row[] = [];

function record(area: string, check: string, result: Row["result"], notes: string) {
  rows.push({ area, check, result, notes });
  const icon = result === "PASS" ? "✓" : result === "WARN" ? "⚠" : result === "SKIP" ? "○" : "✗";
  console.log(`  ${icon} [${area}] ${check} — ${notes}`);
}

async function mustStatus(label: string, res: Response, codes: number[]): Promise<string> {
  const body = await res.text();
  if (!codes.includes(res.status)) {
    throw new Error(`${label}: expected ${codes.join("|")}, got ${res.status}. ${body.slice(0, 300)}`);
  }
  return body;
}

async function getJson(path: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, { headers });
  const body = await r.text();
  return { status: r.status, body, json: body ? JSON.parse(body) : null };
}

async function main() {
  console.log(`Deep live review → ${base}`);
  console.log(`Society: ${societyId}\n`);

  const superUser = process.env.SMOKE_SUPER_USERNAME?.trim();
  const superPass = process.env.SMOKE_SUPER_PASSWORD?.trim();
  const tenantUser =
    process.env.SMOKE_TENANT_ADMIN_USERNAME?.trim() ||
    process.env.SMOKE_ADMIN_USERNAME?.trim();
  const tenantPass =
    process.env.SMOKE_TENANT_ADMIN_PASSWORD?.trim() ||
    process.env.SMOKE_ADMIN_PASSWORD?.trim();
  const guardUser = process.env.MOBILE_SMOKE_GUARD_USER?.trim();
  const guardPass = process.env.MOBILE_SMOKE_GUARD_PASS?.trim();
  const residentUser = process.env.MOBILE_SMOKE_RESIDENT_USER?.trim();
  const residentPass = process.env.MOBILE_SMOKE_RESIDENT_PASS?.trim();

  // ── Platform ─────────────────────────────────────────────────────────
  try {
    const r = await fetch(`${base}/health`);
    const j = JSON.parse(await mustStatus("health", r, [200]));
    if (j.ok !== true || j.db !== true) throw new Error(JSON.stringify(j));
    record("Platform", "GET /health", "PASS", `ok db=${j.db}`);
  } catch (e) {
    record("Platform", "GET /health", "FAIL", String(e));
  }

  try {
    const r = await fetch(`${base}/api/public/societies`);
    const body = await mustStatus("public societies", r, [200]);
    const j = JSON.parse(body) as { societies?: unknown[] };
    record("Platform", "GET /api/public/societies", "PASS", `${j.societies?.length ?? 0} societies`);
  } catch (e) {
    record("Platform", "GET /api/public/societies", "FAIL", String(e));
  }

  try {
    const r = await fetch(`${base}/api/public/app-version?platform=ANDROID`);
    if (r.status === 200) record("Platform", "GET /api/public/app-version", "PASS", "200");
    else if (r.status === 404) record("Platform", "GET /api/public/app-version", "WARN", "404 — route may not be deployed");
    else record("Platform", "GET /api/public/app-version", "FAIL", `status ${r.status}`);
  } catch (e) {
    record("Platform", "GET /api/public/app-version", "FAIL", String(e));
  }

  // OpenAPI docs (non-critical)
  {
    const r = await fetch(`${base}/api/docs/openapi.json`);
    if (r.status === 200) record("Platform", "GET /api/docs/openapi.json", "PASS", "200");
    else record("Platform", "GET /api/docs/openapi.json", "WARN", `${r.status} — docs route not exposed on live (non-blocking)`);
  }

  // ── Auth ─────────────────────────────────────────────────────────────
  let superToken = "";
  if (superUser && superPass) {
    try {
      const r = await fetch(`${base}/api/auth/super-admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: superUser, password: superPass }),
      });
      const body = await mustStatus("super login", r, [200]);
      const j = JSON.parse(body) as { token?: string };
      superToken = j.token ?? "";
      record("Auth", "POST /api/auth/super-admin/login", "PASS", "token received");
    } catch (e) {
      record("Auth", "POST /api/auth/super-admin/login", "FAIL", String(e));
    }
  } else {
    record("Auth", "POST /api/auth/super-admin/login", "SKIP", "no SMOKE_SUPER_*");
  }

  let adminToken = "";
  if (tenantUser && tenantPass) {
    try {
      const r = await fetch(`${base}/api/auth/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ societyId, username: tenantUser, password: tenantPass }),
      });
      if (r.status === 200) {
        const body = await r.text();
        const j = JSON.parse(body) as { token?: string; user?: { role?: string } };
        adminToken = j.token ?? "";
        record("Auth", "POST /api/auth/admin/login", "PASS", `role=${j.user?.role ?? "?"}`);
      } else {
        record("Auth", "POST /api/auth/admin/login", "WARN", `${r.status} — will try tenant-session`);
      }
    } catch (e) {
      record("Auth", "POST /api/auth/admin/login", "WARN", String(e));
    }
  }
  if (!adminToken && superToken) {
    try {
      const r = await fetch(`${base}/api/super/societies/${societyId}/tenant-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${superToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const body = await mustStatus("tenant-session", r, [200]);
      const j = JSON.parse(body) as { token?: string; user?: { role?: string; username?: string } };
      adminToken = j.token ?? "";
      record("Auth", "POST tenant-session (admin)", "PASS", j.user?.username ?? "admin");
    } catch (e) {
      record("Auth", "POST tenant-session (admin)", "FAIL", String(e));
    }
  } else if (!adminToken) {
    record("Auth", "Admin token", "SKIP", "no direct login or super token");
  }

  const guardUserResolved = guardUser || "guard1";
  const guardPassResolved = guardPass || "guard123";
  let guardToken = "";
  try {
    const r = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        societyId,
        username: guardUserResolved,
        password: guardPassResolved,
      }),
    });
    const body = await mustStatus("guard login", r, [200]);
    const j = JSON.parse(body) as { token?: string; user?: { role?: string } };
    guardToken = j.token ?? "";
    record("Auth", "POST /api/auth/login (guard)", "PASS", `${guardUserResolved} role=${j.user?.role ?? "?"}`);
  } catch (e) {
    record("Auth", "POST /api/auth/login (guard)", "FAIL", String(e));
  }

  let residentToken = "";
  if (residentUser && residentPass) {
    try {
      const r = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ societyId, username: residentUser, password: residentPass }),
      });
      const body = await mustStatus("resident login", r, [200]);
      const j = JSON.parse(body) as { token?: string; user?: { role?: string } };
      residentToken = j.token ?? "";
      record("Auth", "POST /api/auth/login (resident)", "PASS", `role=${j.user?.role ?? "?"}`);
    } catch (e) {
      record("Auth", "POST /api/auth/login (resident)", "FAIL", String(e));
    }
  } else {
    record("Auth", "POST /api/auth/login (resident)", "SKIP", "no resident creds");
  }

  const adminHeaders = adminToken
    ? { Authorization: `Bearer ${adminToken}`, "X-Society-Id": societyId }
    : null;
  const guardHeaders = guardToken
    ? { Authorization: `Bearer ${guardToken}`, "X-Society-Id": societyId }
    : null;
  const residentHeaders = residentToken
    ? { Authorization: `Bearer ${residentToken}`, "X-Society-Id": societyId }
    : null;

  async function adminGet(path: string, label: string, expect: number[] = [200]) {
    if (!adminHeaders) {
      record("Admin", label, "SKIP", "no admin token");
      return;
    }
    try {
      const r = await fetch(`${base}${path}`, { headers: adminHeaders });
      const body = await r.text();
      if (r.status >= 500) throw new Error(`${r.status} ${body.slice(0, 200)}`);
      if (!expect.includes(r.status)) throw new Error(`got ${r.status}: ${body.slice(0, 150)}`);
      record("Admin", label, "PASS", `${r.status}`);
    } catch (e) {
      record("Admin", label, "FAIL", String(e));
    }
  }

  async function guardGet(path: string, label: string, allow404 = false) {
    if (!guardHeaders) {
      record("Guard", label, "SKIP", "no guard token");
      return;
    }
    try {
      const r = await fetch(`${base}${path}`, { headers: guardHeaders });
      const body = await r.text();
      if (r.status >= 500) throw new Error(`${r.status} ${body.slice(0, 200)}`);
      if (allow404 && r.status === 404) {
        record("Guard", label, "WARN", `404 — ${body.slice(0, 80)}`);
        return;
      }
      if (![200, 204].includes(r.status)) throw new Error(`got ${r.status}: ${body.slice(0, 150)}`);
      record("Guard", label, "PASS", `${r.status}`);
    } catch (e) {
      record("Guard", label, "FAIL", String(e));
    }
  }

  async function residentGet(path: string, label: string) {
    if (!residentHeaders) {
      record("Resident", label, "SKIP", "no resident token");
      return;
    }
    try {
      const r = await fetch(`${base}${path}`, { headers: residentHeaders });
      const body = await r.text();
      if (r.status >= 500) throw new Error(`${r.status} ${body.slice(0, 200)}`);
      if (![200, 204, 403].includes(r.status)) throw new Error(`got ${r.status}: ${body.slice(0, 150)}`);
      const result = r.status === 403 ? "WARN" : "PASS";
      record("Resident", label, result, `${r.status}`);
    } catch (e) {
      record("Resident", label, "FAIL", String(e));
    }
  }

  // ── Admin billing & disputes ─────────────────────────────────────────
  const month = new Date().getMonth() + 1;
  const year = new Date().getFullYear();
  await adminGet("/api/society-settings", "GET /api/society-settings");
  await adminGet("/api/society-settings/charge-heads", "GET /api/society-settings/charge-heads");
  await adminGet("/api/v1/admin/cycles", "GET /api/v1/admin/cycles", [200, 404]);
  await adminGet("/api/reconciliation/summary", "GET /api/reconciliation/summary");
  await adminGet("/api/reconciliation/alerts?status=unresolved", "GET /api/reconciliation/alerts");
  await adminGet(
    `/api/maintenance-management/financial-dashboard?month=${month}&year=${year}`,
    "GET financial-dashboard",
  );
  await adminGet("/api/payment-disputes", "GET /api/payment-disputes");
  await adminGet("/api/visitors", "GET /api/visitors");
  await adminGet("/api/parcels", "GET /api/parcels");
  await adminGet("/api/complaints", "GET /api/complaints");
  await adminGet("/api/villas", "GET /api/villas");
  await adminGet("/api/users", "GET /api/users");
  await adminGet("/api/notices", "GET /api/notices");
  // No GET /api/guards list route — guard ops use /api/guards/* sub-routes
  await adminGet("/api/system-health", "GET /api/system-health", [200, 404]);

  // G4 FY statement (may 404 if no FY data)
  await adminGet(
    "/api/residents/maintenance-statement/fy?financialYearId=test",
    "GET FY statement route exists",
    [200, 400, 404],
  );

  // ── Guard (G3 area) ──────────────────────────────────────────────────
  await guardGet("/api/guards/my-dashboard", "GET /api/guards/my-dashboard");
  await guardGet("/api/guards/my-visitors", "GET /api/guards/my-visitors");
  await guardGet("/api/guards/pending-visitors", "GET /api/guards/pending-visitors");
  await guardGet("/api/guards/pre-approved-entries", "GET /api/guards/pre-approved-entries");
  await guardGet("/api/guards/residents-directory", "GET /api/guards/residents-directory");
  await guardGet("/api/guards/my-shifts", "GET /api/guards/my-shifts");
  await guardGet("/api/guards/my-gate", "GET /api/guards/my-gate", true);
  await guardGet("/api/guards/parcels-pending", "GET /api/guards/parcels-pending");
  await guardGet("/api/guards/my-patrols", "GET /api/guards/my-patrols");

  // G3 routes exist (auth required — 401 without token)
  {
    const r = await fetch(`${base}/api/guards/visitor-checkin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (r.status === 401) record("Guard G3", "POST visitor-checkin (no auth)", "PASS", "401 as expected");
    else if (r.status === 400) record("Guard G3", "POST visitor-checkin (no auth)", "WARN", "400 — auth may run after body parse");
    else record("Guard G3", "POST visitor-checkin (no auth)", "FAIL", `status ${r.status}`);
  }

  // ── Resident mobile paths ────────────────────────────────────────────
  await residentGet("/api/residents/dashboard", "GET dashboard");
  await residentGet("/api/residents/maintenance-dashboard", "GET maintenance-dashboard");
  await residentGet("/api/residents/maintenance-pending", "GET maintenance-pending");
  await residentGet("/api/residents/outstanding-dues", "GET outstanding-dues");
  await residentGet("/api/v1/financial-years", "GET /api/v1/financial-years");
  await residentGet("/api/residents/my-visitors", "GET my-visitors");
  await residentGet("/api/residents/visitor-approval-requests", "GET visitor approvals");
  await residentGet("/api/residents/my-parcels", "GET my-parcels");
  await residentGet("/api/notifications", "GET notifications");

  // Payment disputes resident path
  await residentGet("/api/residents/payment-disputes", "GET payment-disputes");

  // ── Super admin ──────────────────────────────────────────────────────
  if (superToken) {
    try {
      const r = await fetch(`${base}/api/super/societies`, {
        headers: { Authorization: `Bearer ${superToken}` },
      });
      await mustStatus("super societies", r, [200]);
      record("Super", "GET /api/super/societies", "PASS", "200");
    } catch (e) {
      record("Super", "GET /api/super/societies", "FAIL", String(e));
    }
    try {
      const r = await fetch(`${base}/api/super/societies/${societyId}`, {
        headers: { Authorization: `Bearer ${superToken}` },
      });
      await mustStatus("super society detail", r, [200]);
      record("Super", "GET /api/super/societies/:id", "PASS", "200");
    } catch (e) {
      record("Super", "GET /api/super/societies/:id", "FAIL", String(e));
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────
  const pass = rows.filter((r) => r.result === "PASS").length;
  const fail = rows.filter((r) => r.result === "FAIL").length;
  const warn = rows.filter((r) => r.result === "WARN").length;
  const skip = rows.filter((r) => r.result === "SKIP").length;

  console.log("\n═══════════════════════════════════════");
  console.log(`Deep live review: PASS=${pass} FAIL=${fail} WARN=${warn} SKIP=${skip}`);
  console.log("═══════════════════════════════════════\n");

  if (fail > 0) {
    console.log("FAILURES:");
    for (const r of rows.filter((x) => x.result === "FAIL")) {
      console.log(`  • [${r.area}] ${r.check}: ${r.notes}`);
    }
    process.exit(1);
  }

  if (warn > 0) {
    console.log("WARNINGS (non-blocking):");
    for (const r of rows.filter((x) => x.result === "WARN")) {
      console.log(`  • [${r.area}] ${r.check}: ${r.notes}`);
    }
  }

  console.log("\nDeep live review PASSED (no critical failures).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
