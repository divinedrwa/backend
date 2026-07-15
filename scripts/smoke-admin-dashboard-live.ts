#!/usr/bin/env npx tsx
/**
 * Smoke-check the four APIs that power the Flutter admin dashboard tab.
 * Usage:
 *   HTTP_SMOKE_BASE=https://gatepass-v037.onrender.com \
 *   SMOKE_ADMIN_USERNAME=... SMOKE_ADMIN_PASSWORD=... \
 *   npx tsx scripts/smoke-admin-dashboard-live.ts
 */

const base = (process.env.HTTP_SMOKE_BASE ?? "https://gatepass-v037.onrender.com").replace(
  /\/$/,
  "",
);
const adminUser = process.env.SMOKE_ADMIN_USERNAME?.trim();
const adminPass = process.env.SMOKE_ADMIN_PASSWORD?.trim();

async function main(): Promise<void> {
  if (!adminUser || !adminPass) {
    throw new Error("Set SMOKE_ADMIN_USERNAME and SMOKE_ADMIN_PASSWORD");
  }

  const societiesRes = await fetch(`${base}/api/public/societies`);
  const societiesJson = (await societiesRes.json()) as { societies?: { id: string }[] };
  const societies = societiesJson.societies ?? [];

  let token = "";
  let societyId = "";
  const loginPath = process.env.SMOKE_LOGIN_PATH?.trim() || "/api/auth/login";
  for (const s of societies) {
    const r = await fetch(`${base}${loginPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        societyId: s.id,
        username: adminUser,
        password: adminPass,
      }),
    });
    if (r.status !== 200) continue;
    const j = (await r.json()) as { token?: string };
    if (j.token) {
      token = j.token;
      societyId = s.id;
      break;
    }
  }

  if (!token) throw new Error("admin/login failed for all societies");

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const paths: [string, string][] = [
    ["/api/visitors", "visitors"],
    ["/api/parcels", "parcels"],
    ["/api/complaints", "complaints"],
    [
      `/api/maintenance-management/financial-dashboard?month=${month}&year=${year}`,
      "financial-dashboard",
    ],
  ];

  console.log(`Admin dashboard smoke → ${base} (societyId=${societyId})`);

  for (const [path, label] of paths) {
    const t0 = Date.now();
    const r = await fetch(`${base}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Society-Id": societyId,
      },
    });
    const ms = Date.now() - t0;
    const text = await r.text();
    const line = `${label}: status=${r.status} timeMs=${ms} bodyLen=${text.length}`;
    if (r.status >= 400) {
      console.log(`${line} snippet=${text.slice(0, 300)}`);
    } else {
      console.log(line);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
