#!/usr/bin/env npx tsx
/**
 * HTTP smoke checks against a running API (default http://127.0.0.1:4000).
 *
 * Usage (from backend/):
 *   npm run smoke:http
 *   HTTP_SMOKE_BASE=https://staging.example.com/api node --import tsx scripts/smoke-http.ts
 *
 * Note: BASE should be the **API origin** — paths used are `/health` and `/api/...`.
 * If your gateway strips `/api`, set HTTP_SMOKE_BASE accordingly and adjust HEALTH_PATH env.
 *
 * Optional tenant admin check:
 *   SMOKE_ADMIN_USERNAME=admin SMOKE_ADMIN_PASSWORD=...
 *   SMOKE_SOCIETY_ID optional — if omitted but username+password set, uses first ACTIVE society from GET /api/public/societies.
 *
 * Optional super-admin check:
 *   SMOKE_SUPER_USERNAME=... SMOKE_SUPER_PASSWORD=... npm run smoke:http
 */

const base = process.env.HTTP_SMOKE_BASE?.replace(/\/$/, "") ?? "http://127.0.0.1:4000";
const healthPath = process.env.HTTP_SMOKE_HEALTH_PATH ?? "/health";

type SocietyRow = { id: string; name?: string; address?: unknown; status?: unknown };

async function mustStatus(
  label: string,
  res: Response,
  codes: number[],
): Promise<Response> {
  if (!codes.includes(res.status)) {
    const body = await res.text();
    throw new Error(`${label}: expected ${codes.join("|")}, got ${res.status}. Body: ${body.slice(0, 400)}`);
  }
  return res;
}

async function main(): Promise<void> {
  console.log(`HTTP smoke → ${base}`);

  {
    const r = await fetch(new URL(healthPath, base).toString(), { method: "GET" });
    await mustStatus("GET /health", r, [200]);
    const j = (await r.json()) as { ok?: boolean };
    if (j.ok !== true) throw new Error("GET /health: expected { ok: true }");
    console.log("  ✓ GET /health");
  }

  let societies: SocietyRow[] = [];
  {
    const r = await fetch(new URL("/api/public/societies", base).toString(), { method: "GET" });
    await mustStatus("GET /api/public/societies", r, [200]);
    const j = (await r.json()) as { societies?: unknown };
    if (!Array.isArray(j.societies)) throw new Error("GET /public/societies: expected { societies: array }");
    societies = j.societies as SocietyRow[];
    console.log(`  ✓ GET /api/public/societies (${societies.length} societies)`);
  }

  {
    const r = await fetch(new URL("/api/auth/logout", base).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await mustStatus("POST /api/auth/logout", r, [204]);
    console.log("  ✓ POST /api/auth/logout (204)");
  }

  const envSocietyId = process.env.SMOKE_SOCIETY_ID?.trim();
  const superUser = process.env.SMOKE_SUPER_USERNAME?.trim();
  const superPass = process.env.SMOKE_SUPER_PASSWORD?.trim();
  const tenantUser =
    process.env.SMOKE_TENANT_ADMIN_USERNAME?.trim() ??
    (process.env.SMOKE_ADMIN_USERNAME?.trim() &&
    process.env.SMOKE_ADMIN_USERNAME.trim() !== superUser
      ? process.env.SMOKE_ADMIN_USERNAME.trim()
      : undefined);
  const tenantPass =
    process.env.SMOKE_TENANT_ADMIN_PASSWORD?.trim() ??
    (tenantUser && process.env.SMOKE_ADMIN_PASSWORD?.trim() !== superPass
      ? process.env.SMOKE_ADMIN_PASSWORD?.trim()
      : undefined);

  if (tenantUser && tenantPass) {
    const attemptIds =
      envSocietyId ?
        [envSocietyId]
      : societies.map((s) => s.id).filter(Boolean);

    if (attemptIds.length === 0) {
      throw new Error("admin/login: no societies to try");
    }

    let lastBody = "";
    let lastStatus = 0;
    let ok: { societyId: string; role: string; tokenPresent: boolean } | null = null;

    for (const sid of attemptIds) {
      const r = await fetch(new URL("/api/auth/admin/login", base).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          societyId: sid,
          username: tenantUser,
          password: tenantPass,
        }),
      });
      lastStatus = r.status;
      lastBody = await r.text();

      if (r.status !== 200) continue;

      const j = JSON.parse(lastBody) as { token?: string; user?: { role?: string } };
      if (j.token) {
        ok = { societyId: sid, role: j.user?.role ?? "?", tokenPresent: true };
        break;
      }
    }

    if (!ok) {
      if (superUser && superPass) {
        console.log(
          `  · skip tenant admin/login (${attemptIds.length} tried) — will use super-admin check`,
        );
      } else {
        throw new Error(
          `POST /api/auth/admin/login: no matching society (${attemptIds.length} tried). Last status=${lastStatus} body=${lastBody.slice(0, 260)}`,
        );
      }
    } else {
      if (!envSocietyId && attemptIds.length > 1) {
        console.log(`  · admin/login matched societyId=${ok.societyId} (among ${attemptIds.length} ACTIVE societies)`);
      }
      console.log(`  ✓ POST /api/auth/admin/login (${ok.role})`);
    }
  } else {
    console.log(
      "  · skip tenant admin/login (set SMOKE_TENANT_ADMIN_* or SMOKE_ADMIN_* distinct from super)",
    );
  }

  if (superUser && superPass) {
    const r = await fetch(new URL("/api/auth/super-admin/login", base).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: superUser, password: superPass }),
    });
    await mustStatus("POST /api/auth/super-admin/login", r, [200]);
    const j = (await r.json()) as { token?: string; user?: { role?: string } };
    if (!j.token) throw new Error("super-admin/login: missing token");
    console.log(`  ✓ POST /api/auth/super-admin/login (${j.user?.role ?? "?"})`);
  } else {
    console.log("  · skip super-admin/login (set SMOKE_SUPER_USERNAME + SMOKE_SUPER_PASSWORD)");
  }

  console.log("Smoke passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
