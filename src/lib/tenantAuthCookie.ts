/**
 * E1 — HttpOnly tenant auth cookies (optional, backward-compatible with Bearer header).
 */
import type { Response } from "express";

const TENANT_TOKEN_COOKIE = "tenant_token";
const TENANT_REFRESH_COOKIE = "tenant_refresh";
const MAX_AGE_SEC = 60 * 60 * 24 * 7;

export function isHttpOnlyTenantAuthEnabled(): boolean {
  return process.env.TENANT_HTTPONLY_AUTH === "true";
}

export function setTenantAuthCookies(
  res: Response,
  tokens: { token: string; refreshToken: string },
): void {
  if (!isHttpOnlyTenantAuthEnabled()) return;
  const secure = process.env.NODE_ENV === "production";
  const base = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", [
    `${TENANT_TOKEN_COOKIE}=${encodeURIComponent(tokens.token)}; Max-Age=${MAX_AGE_SEC}; ${base}`,
    `${TENANT_REFRESH_COOKIE}=${encodeURIComponent(tokens.refreshToken)}; Max-Age=${MAX_AGE_SEC * 4}; ${base}`,
  ]);
}

export function clearTenantAuthCookies(res: Response): void {
  if (!isHttpOnlyTenantAuthEnabled()) return;
  const base = "Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
  res.setHeader("Set-Cookie", [
    `${TENANT_TOKEN_COOKIE}=; ${base}`,
    `${TENANT_REFRESH_COOKIE}=; ${base}`,
  ]);
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  }
  return out;
}

export function readBearerOrCookieToken(
  authorization: string | undefined,
  cookieHeader: string | undefined,
): string | null {
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice(7);
  }
  if (!isHttpOnlyTenantAuthEnabled()) return null;
  const cookies = parseCookieHeader(cookieHeader);
  return cookies[TENANT_TOKEN_COOKIE] ?? null;
}
