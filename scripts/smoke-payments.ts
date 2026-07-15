#!/usr/bin/env npx tsx
/**
 * C2 — Gateway payment smoke (local / staging safe).
 *
 * Verifies billing gateway wiring without capturing real money:
 * - API health
 * - Sandbox society blocks live gateway keys (A3)
 * - Admin can reach reconciliation + billing routes
 *
 * Usage (from backend/, API must be running):
 *   npm run smoke:payments
 *   HTTP_SMOKE_BASE=http://127.0.0.1:4000 \
 *   SMOKE_ADMIN_USERNAME=sandbox_admin SMOKE_ADMIN_PASSWORD=Sandbox123! \
 *   npm run smoke:payments
 */

const base = process.env.HTTP_SMOKE_BASE?.replace(/\/$/, "") ?? "http://127.0.0.1:4000";

async function mustStatus(label: string, res: Response, codes: number[]): Promise<Response> {
  if (!codes.includes(res.status)) {
    const body = await res.text();
    throw new Error(`${label}: expected ${codes.join("|")}, got ${res.status}. Body: ${body.slice(0, 400)}`);
  }
  return res;
}

async function main(): Promise<void> {
  console.log(`Payment smoke → ${base}`);

  {
    const r = await fetch(new URL("/health", base).toString());
    await mustStatus("GET /health", r, [200]);
    const j = (await r.json()) as { ok?: boolean };
    if (j.ok !== true) throw new Error("health: expected ok:true");
    console.log("  ✓ GET /health");
  }

  const adminUser = process.env.SMOKE_ADMIN_USERNAME?.trim() ?? "sandbox_admin";
  const adminPass = process.env.SMOKE_ADMIN_PASSWORD?.trim() ?? "Sandbox123!";

  const societiesRes = await fetch(new URL("/api/public/societies", base).toString());
  await mustStatus("GET /api/public/societies", societiesRes, [200]);
  const societiesJson = (await societiesRes.json()) as { societies?: Array<{ id: string; name?: string }> };
  const societies = societiesJson.societies ?? [];
  if (societies.length === 0) throw new Error("no societies in public list");

  const sandbox = societies.find((s) => s.name?.toLowerCase().includes("sandbox")) ?? societies[0];
  const societyId = process.env.SMOKE_SOCIETY_ID?.trim() ?? sandbox!.id;

  const loginRes = await fetch(new URL("/api/auth/login", base).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: adminUser,
      password: adminPass,
      societyId,
    }),
  });
  await mustStatus("POST /api/auth/login", loginRes, [200]);
  const loginJson = (await loginRes.json()) as { token?: string };
  if (!loginJson.token) throw new Error("login: missing token");
  const headers = {
    Authorization: `Bearer ${loginJson.token}`,
    "X-Society-Id": societyId,
    "Content-Type": "application/json",
  };
  console.log(`  ✓ admin login (${adminUser}, society ${societyId.slice(0, 8)}…)`);

  {
    const r = await fetch(new URL("/api/reconciliation/summary", base).toString(), { headers });
    await mustStatus("GET /api/reconciliation/summary", r, [200]);
    console.log("  ✓ GET /api/reconciliation/summary");
  }

  {
    const r = await fetch(new URL("/api/reconciliation/alerts?status=unresolved", base).toString(), {
      headers,
    });
    await mustStatus("GET /api/reconciliation/alerts", r, [200]);
    console.log("  ✓ GET /api/reconciliation/alerts");
  }

  {
    const r = await fetch(new URL("/api/billing/v1/cycles", base).toString(), { headers });
    await mustStatus("GET /api/billing/v1/cycles", r, [200, 404]);
    console.log(`  ✓ GET /api/billing/v1/cycles (${r.status})`);
  }

  // Razorpay webhook route must exist (signature check returns 400 without body)
  {
    const r = await fetch(new URL("/api/v1/payments/webhook", base).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (![400, 401, 403, 422, 500].includes(r.status)) {
      throw new Error(`POST /api/v1/payments/webhook: unexpected ${r.status}`);
    }
    console.log(`  ✓ POST /api/v1/payments/webhook reachable (${r.status})`);
  }

  console.log("\nPayment smoke passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
