import type { SmokeContext, SmokeIds, SmokeResult, SmokeTokens, MobileApiCase, MobileApiRole } from "./types";

const PLACEHOLDER_RE = /:(\w+)/g;

export function resolvePath(path: string, ctx: SmokeContext): { path: string; missing: string[] } {
  const missing: string[] = [];
  const resolved = path.replace(PLACEHOLDER_RE, (_, key: string) => {
    if (key === "societyId") return ctx.societyId;
    const val = ctx.ids[key as keyof SmokeIds];
    if (!val) {
      missing.push(key);
      return `__missing_${key}__`;
    }
    return val;
  });
  return { path: resolved, missing };
}

export function resolveQuery(
  query: Record<string, string> | undefined,
  ctx: SmokeContext,
): { query?: Record<string, string>; missing: string[] } {
  if (!query) return { query: undefined, missing: [] };
  const missing: string[] = [];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v.startsWith(":")) {
      const key = v.slice(1);
      if (key === "societyId") {
        out[k] = ctx.societyId;
        continue;
      }
      const val = ctx.ids[key as keyof SmokeIds];
      if (!val) {
        missing.push(key);
        out[k] = "";
      } else {
        out[k] = val;
      }
    } else {
      out[k] = v;
    }
  }
  return { query: out, missing };
}

export function resolveBody(
  body: Record<string, unknown> | undefined,
  ctx: SmokeContext,
): { body?: Record<string, unknown>; missing: string[] } {
  if (!body) return { body: undefined, missing: [] };
  const missing: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string" && v.startsWith(":")) {
      const key = v.slice(1);
      const val = key === "societyId" ? ctx.societyId : ctx.ids[key as keyof SmokeIds];
      if (!val) missing.push(key);
      else out[k] = val;
    } else {
      out[k] = v;
    }
  }
  return { body: out, missing };
}

function tokenForRole(role: MobileApiRole, tokens: SmokeTokens): string | undefined {
  if (role === "public") return undefined;
  return tokens[role];
}

export async function runApiCase(
  baseUrl: string,
  ctx: SmokeContext,
  apiCase: MobileApiCase,
  role: MobileApiRole,
): Promise<SmokeResult> {
  const token = tokenForRole(role, ctx.tokens);

  if (role !== "public" && !token) {
    return {
      name: apiCase.name,
      role,
      method: apiCase.method,
      path: apiCase.path,
      status: 0,
      ok: true,
      skipped: true,
      reason: `no ${role} token`,
    };
  }

  const pathRes = resolvePath(apiCase.path, ctx);
  const queryRes = resolveQuery(apiCase.query, ctx);
  const bodyRes = resolveBody(apiCase.body, ctx);
  const missing = [...new Set([...pathRes.missing, ...queryRes.missing, ...bodyRes.missing])];

  if (missing.length > 0) {
    if (apiCase.optional) {
      return {
        name: apiCase.name,
        role,
        method: apiCase.method,
        path: apiCase.path,
        status: 0,
        ok: true,
        skipped: true,
        reason: `missing ids: ${missing.join(", ")}`,
      };
    }
    return {
      name: apiCase.name,
      role,
      method: apiCase.method,
      path: apiCase.path,
      status: 0,
      ok: false,
      reason: `missing ids: ${missing.join(", ")}`,
    };
  }

  const url = new URL(`/api${pathRes.path}`, baseUrl);
  if (queryRes.query) {
    for (const [k, v] of Object.entries(queryRes.query)) {
      if (v) url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (bodyRes.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Society-Id"] = ctx.societyId;
  }

  const res = await fetch(url.toString(), {
    method: apiCase.method,
    headers,
    body: bodyRes.body !== undefined ? JSON.stringify(bodyRes.body) : undefined,
  });

  const text = await res.text();
  const preview = text.slice(0, 240);
  const is500 = res.status >= 500;
  const ok = !is500 && apiCase.expect.includes(res.status);

  return {
    name: apiCase.name,
    role,
    method: apiCase.method,
    path: apiCase.path,
    status: res.status,
    ok,
    bodyPreview: ok ? undefined : preview,
  };
}

export async function mustHealth(baseUrl: string): Promise<void> {
  const r = await fetch(new URL("/health", baseUrl).toString());
  if (!r.ok) throw new Error(`GET /health failed: ${r.status}`);
  const j = (await r.json()) as { ok?: boolean };
  if (j.ok !== true) throw new Error("GET /health: expected { ok: true }");
}

export type LoginResult = { token: string; societyId: string; role: string };
export type LoginFailure = { status: number; message: string };

export async function tenantLogin(
  baseUrl: string,
  societyId: string,
  username: string,
  password: string,
): Promise<LoginResult | LoginFailure> {
  const r = await fetch(new URL("/api/auth/login", baseUrl).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ societyId, username, password }),
  });
  if (!r.ok) {
    let message = `HTTP ${r.status}`;
    try {
      const j = (await r.json()) as { message?: string };
      if (j.message) message = j.message;
    } catch {
      /* ignore */
    }
    return { status: r.status, message };
  }
  const j = (await r.json()) as { token?: string; user?: { role?: string; societyId?: string } };
  if (!j.token) return { status: r.status, message: "no token in response" };
  return {
    token: j.token,
    societyId: j.user?.societyId ?? societyId,
    role: j.user?.role ?? "?",
  };
}

export async function adminLogin(
  baseUrl: string,
  societyId: string,
  username: string,
  password: string,
): Promise<LoginResult | null> {
  const r = await fetch(new URL("/api/auth/admin/login", baseUrl).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ societyId, username, password }),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { token?: string; user?: { role?: string; societyId?: string } };
  if (!j.token) return null;
  return {
    token: j.token,
    societyId: j.user?.societyId ?? societyId,
    role: j.user?.role ?? "?",
  };
}

export async function fetchPublicSocieties(baseUrl: string): Promise<Array<{ id: string }>> {
  const r = await fetch(new URL("/api/public/societies", baseUrl).toString());
  if (!r.ok) throw new Error(`GET /public/societies: ${r.status}`);
  const j = (await r.json()) as { societies?: Array<{ id: string }> };
  return j.societies ?? [];
}

export async function authedGet<T>(
  baseUrl: string,
  path: string,
  token: string,
  societyId: string,
): Promise<T | null> {
  const r = await fetch(new URL(`/api${path}`, baseUrl).toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Society-Id": societyId,
      Accept: "application/json",
    },
  });
  if (!r.ok) return null;
  return (await r.json()) as T;
}

export function firstId(list: unknown, keys: string[]): string | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const row = list[0];
  if (!row || typeof row !== "object") return undefined;
  const rec = row as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export function extractList(data: unknown, keys: string[]): unknown[] {
  if (!data || typeof data !== "object") return [];
  const rec = data as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (Array.isArray(v)) return v;
  }
  if (Array.isArray(data)) return data;
  return [];
}
