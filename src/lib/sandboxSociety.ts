import { PaymentMethodType } from "@prisma/client";
import { prisma } from "./prisma";

let isSandboxColumnKnown: boolean | null = null;
let isSandboxColumnCheckedAt = 0;
const COLUMN_CACHE_TTL_MS = 60_000;

/** Read-only: does `Society.isSandbox` exist on the connected DB? */
export async function societyIsSandboxColumnExists(): Promise<boolean> {
  const now = Date.now();
  if (isSandboxColumnKnown !== null && now - isSandboxColumnCheckedAt < COLUMN_CACHE_TTL_MS) {
    return isSandboxColumnKnown;
  }

  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Society'
        AND column_name = 'isSandbox'
    ) AS "exists"
  `;
  isSandboxColumnKnown = Boolean(rows[0]?.exists);
  isSandboxColumnCheckedAt = now;
  return isSandboxColumnKnown;
}

export async function isSandboxSociety(societyId: string): Promise<boolean> {
  if (!(await societyIsSandboxColumnExists())) return false;
  const row = await prisma.society.findUnique({
    where: { id: societyId },
    select: { isSandbox: true },
  });
  return row?.isSandbox === true;
}

/** Razorpay test keys start with `rzp_test_`; live keys with `rzp_live_`. */
export function isRazorpayTestKeyId(keyId: string | undefined | null): boolean {
  const k = (keyId ?? "").trim().toLowerCase();
  return k.startsWith("rzp_test_");
}

export function isRazorpayLiveKeyId(keyId: string | undefined | null): boolean {
  const k = (keyId ?? "").trim().toLowerCase();
  return k.startsWith("rzp_live_");
}

export function parsePhonePeEnvironment(
  raw: string | undefined | null,
): "SANDBOX" | "PRODUCTION" {
  const v = (raw ?? "SANDBOX").trim().toUpperCase();
  return v === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
}

export type SandboxGatewayConfigIssue = {
  code: "SANDBOX_LIVE_GATEWAY_FORBIDDEN";
  message: string;
};

/**
 * Returns an issue when a sandbox society is configured with live gateway credentials.
 * UPI / bank transfer configs are always allowed on sandbox.
 */
export function validateGatewayConfigForSandbox(
  type: PaymentMethodType,
  config: Record<string, unknown>,
): SandboxGatewayConfigIssue | null {
  if (type === PaymentMethodType.RAZORPAY) {
    const keyId = typeof config.keyId === "string" ? config.keyId : "";
    if (isRazorpayLiveKeyId(keyId)) {
      return {
        code: "SANDBOX_LIVE_GATEWAY_FORBIDDEN",
        message:
          "Sandbox societies cannot use live Razorpay keys (rzp_live_*). Use test keys (rzp_test_*) or record cash/UPI manually.",
      };
    }
    if (keyId && !isRazorpayTestKeyId(keyId)) {
      return {
        code: "SANDBOX_LIVE_GATEWAY_FORBIDDEN",
        message:
          "Sandbox societies require Razorpay test keys (rzp_test_*). Unrecognized key id prefix.",
      };
    }
    return null;
  }

  if (type === PaymentMethodType.PHONEPE) {
    const env = parsePhonePeEnvironment(
      typeof config.environment === "string" ? config.environment : undefined,
    );
    if (env === "PRODUCTION") {
      return {
        code: "SANDBOX_LIVE_GATEWAY_FORBIDDEN",
        message:
          "Sandbox societies cannot use PhonePe PRODUCTION environment. Set environment to SANDBOX.",
      };
    }
    return null;
  }

  return null;
}

async function resolveRazorpayKeyIdForSociety(societyId: string): Promise<string | undefined> {
  const method = await prisma.paymentMethod.findFirst({
    where: {
      societyId,
      type: PaymentMethodType.RAZORPAY,
      isEnabled: true,
    },
    select: { config: true },
  });
  if (method) {
    const config = method.config as Record<string, unknown>;
    return typeof config.keyId === "string" ? config.keyId : undefined;
  }
  return process.env.RAZORPAY_KEY_ID?.trim();
}

async function resolvePhonePeEnvironmentForSociety(
  societyId: string,
): Promise<"SANDBOX" | "PRODUCTION" | null> {
  const method = await prisma.paymentMethod.findFirst({
    where: {
      societyId,
      type: PaymentMethodType.PHONEPE,
      isEnabled: true,
    },
    select: { config: true },
  });
  if (method) {
    const config = method.config as Record<string, unknown>;
    return parsePhonePeEnvironment(
      typeof config.environment === "string" ? config.environment : undefined,
    );
  }
  if (process.env.PHONEPE_CLIENT_ID || process.env.PHONEPE_MERCHANT_ID) {
    return parsePhonePeEnvironment(process.env.PHONEPE_ENVIRONMENT);
  }
  return null;
}

export type OnlineGatewayCaptureBlock = {
  blocked: true;
  code: "SANDBOX_LIVE_GATEWAY_FORBIDDEN";
  message: string;
};

/**
 * Before creating a Razorpay order or initiating PhonePe, ensure sandbox societies
 * are not using live gateway credentials.
 */
export async function checkOnlineGatewayCaptureAllowed(
  societyId: string,
): Promise<OnlineGatewayCaptureBlock | null> {
  if (!(await isSandboxSociety(societyId))) return null;

  const razorpayKeyId = await resolveRazorpayKeyIdForSociety(societyId);
  if (razorpayKeyId) {
    const issue = validateGatewayConfigForSandbox(PaymentMethodType.RAZORPAY, {
      keyId: razorpayKeyId,
    });
    if (issue) return { blocked: true, ...issue };
  }

  const phonePeEnv = await resolvePhonePeEnvironmentForSociety(societyId);
  if (phonePeEnv === "PRODUCTION") {
    return {
      blocked: true,
      code: "SANDBOX_LIVE_GATEWAY_FORBIDDEN",
      message:
        "Sandbox societies cannot capture payments via PhonePe PRODUCTION. Use SANDBOX keys or cash/UPI manual entry.",
    };
  }

  return null;
}
