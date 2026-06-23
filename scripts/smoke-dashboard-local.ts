#!/usr/bin/env npx tsx
/**
 * Smoke dashboard tenant APIs on local server (reads creds from env).
 * Usage: cd backend && npx tsx scripts/smoke-dashboard-local.ts
 */
import "dotenv/config";

const base = (process.env.HTTP_SMOKE_BASE ?? "http://127.0.0.1:4000").replace(/\/$/, "");

async function main(): Promise<void> {
  const societiesRes = await fetch(`${base}/api/public/societies?limit=10`);
  const societiesJson = (await societiesRes.json()) as { societies?: Array<{ id: string; name: string }> };
  const societyId =
    process.env.SMOKE_SOCIETY_ID?.trim() ?? societiesJson.societies?.[0]?.id;
  const username = process.env.SMOKE_ADMIN_USERNAME?.trim();
  const password = process.env.SMOKE_ADMIN_PASSWORD?.trim();

  if (!societyId || !username || !password) {
    console.error("Set SMOKE_ADMIN_USERNAME, SMOKE_ADMIN_PASSWORD (optional SMOKE_SOCIETY_ID)");
    process.exit(1);
  }

  const loginRes = await fetch(`${base}/api/auth/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ societyId, username, password }),
  });
  if (!loginRes.ok) {
    console.error("Login failed:", loginRes.status, await loginRes.text());
    process.exit(1);
  }
  const login = (await loginRes.json()) as { token?: string };
  const token = login.token;
  if (!token) {
    console.error("No token in login response");
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Society-Id": societyId,
  };

  const paths = [
    "/api/villas?limit=1&offset=0",
    "/api/users?role=RESIDENT&isActive=true&limit=1&offset=0",
    "/api/maintenance/dashboard",
    "/api/maintenance-management/financial-dashboard",
    "/api/visitors?limit=5&offset=0",
    "/api/gates",
    "/api/v1/admin/cycles",
  ];

  console.log(`Dashboard smoke → ${base} (society ${societyId})`);
  let failed = 0;
  for (const path of paths) {
    const r = await fetch(`${base}${path}`, { headers });
    const ok = r.ok;
    if (!ok) failed += 1;
    const preview = ok ? "" : ` — ${(await r.text()).slice(0, 120)}`;
    console.log(`  ${ok ? "✓" : "✗"} ${path} [${r.status}]${preview}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main();
