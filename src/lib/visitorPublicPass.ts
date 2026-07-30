import { createHash, randomBytes } from "node:crypto";

export const PUBLIC_PASS_TOKEN_BYTES = 32;

export type VisitorPublicPassStatus =
  | "ACTIVE"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "USED"
  | "CANCELLED";

type PublicPassState = {
  validFrom?: Date | string | null;
  validUntil?: Date | string | null;
  isActive: boolean;
  isUsed: boolean;
  isRecurring: boolean;
  maxUses: number | null;
  usedCount: number;
};

export function createVisitorPublicPassToken(): {
  rawToken: string;
  tokenHash: string;
} {
  const rawToken = randomBytes(PUBLIC_PASS_TOKEN_BYTES).toString("base64url");
  return { rawToken, tokenHash: hashVisitorPublicPassToken(rawToken) };
}

export function hashVisitorPublicPassToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function isValidVisitorPublicPassToken(rawToken: string): boolean {
  // 32 random bytes in base64url is 43 chars. Keep a bounded range so malformed
  // requests never reach the database and cannot create oversized log/query data.
  return /^[A-Za-z0-9_-]{40,64}$/.test(rawToken);
}

export function getVisitorPassBaseUrl(): string | null {
  const configured = (
    process.env.VISITOR_PASS_BASE_URL ??
    process.env.FRONTEND_URL ??
    ""
  ).trim();
  if (!configured) return null;

  try {
    const parsed = new URL(configured);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function buildVisitorPublicPassUrl(rawToken: string): string | null {
  const base = getVisitorPassBaseUrl();
  if (!base) return null;
  return `${base}/visit/${encodeURIComponent(rawToken)}`;
}

export function resolveVisitorPublicPassStatus(
  pass: PublicPassState,
  now = new Date(),
): VisitorPublicPassStatus {
  if (!pass.isActive) return "CANCELLED";
  if (pass.validFrom && new Date(pass.validFrom) > now) return "NOT_YET_VALID";
  if (pass.validUntil && new Date(pass.validUntil) <= now) return "EXPIRED";
  if (pass.isRecurring) {
    if (pass.maxUses != null && pass.usedCount >= pass.maxUses) return "USED";
    return "ACTIVE";
  }
  return pass.isUsed ? "USED" : "ACTIVE";
}
