import crypto from "crypto";
import { PaymentMethodType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { isEncrypted } from "../lib/paymentSecrets";
import { decryptConfigSecrets } from "../modules/payment-methods/service";
import { logger } from "../lib/logger";
import {
  buildPhonePeStatusPending,
  buildPhonePeStatusUnavailable,
  classifyPhonePeGatewayPayload,
  isPhonePePaymentFailed,
  isPhonePePaymentSuccessful,
  type PhonePeStatusResult,
} from "./phonepe-status";

export {
  PHONEPE_COMPLETED_STATES,
  PHONEPE_FAILED_STATES,
  PHONEPE_PENDING_STATES,
  isPhonePePaymentSuccessful,
  isPhonePePaymentFailed,
  classifyPhonePeGatewayPayload,
  mergePhonePeStatusWithLocal,
  type PhonePeSettlementOutcome,
  type PhonePeStatusResult,
} from "./phonepe-status";

export type PhonePeConfig = {
  merchantId: string;
  saltKey: string;
  saltIndex: number;
  environment: "SANDBOX" | "PRODUCTION";
};

const BASE_URLS = {
  SANDBOX: "https://api-preprod.phonepe.com/apis/pg-sandbox",
  PRODUCTION: "https://api.phonepe.com/apis/hermes",
} as const;

function parsePhonePeEnvironment(raw: string | undefined): "SANDBOX" | "PRODUCTION" {
  const v = (raw ?? "SANDBOX").toUpperCase();
  return v === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
}

/** Global PhonePe credentials from environment (Render / local .env). */
export function getEnvPhonePeConfig(): PhonePeConfig | null {
  const merchantId = process.env.PHONEPE_MERCHANT_ID?.trim();
  const saltKey = process.env.PHONEPE_SALT_KEY?.trim();
  if (!merchantId || !saltKey) return null;

  const saltIndexRaw = process.env.PHONEPE_SALT_INDEX?.trim();
  const saltIndex = saltIndexRaw ? Number.parseInt(saltIndexRaw, 10) : 1;

  return {
    merchantId,
    saltKey,
    saltIndex: Number.isFinite(saltIndex) && saltIndex > 0 ? saltIndex : 1,
    environment: parsePhonePeEnvironment(process.env.PHONEPE_ENVIRONMENT),
  };
}

export function isPhonePeConfigured(): boolean {
  return getEnvPhonePeConfig() !== null;
}

async function getPhonePeConfigFromDb(societyId: string): Promise<PhonePeConfig | null> {
  const method = await prisma.paymentMethod.findFirst({
    where: {
      societyId,
      type: PaymentMethodType.PHONEPE,
      isEnabled: true,
    },
  });

  if (!method) return null;

  const config = decryptConfigSecrets(method.type, method.config as Record<string, unknown>);
  const { merchantId, saltKey, saltIndex, environment } = config as Record<string, unknown>;

  if (!merchantId || !saltKey) return null;
  if (typeof saltKey === "string" && isEncrypted(saltKey as string)) {
    logger.error("PhonePe saltKey is still encrypted — PAYMENT_SECRETS_KEY env var is missing or wrong");
    return null;
  }

  const idx =
    typeof saltIndex === "number"
      ? saltIndex
      : typeof saltIndex === "string"
        ? Number.parseInt(saltIndex, 10)
        : 1;

  return {
    merchantId: merchantId as string,
    saltKey: saltKey as string,
    saltIndex: Number.isFinite(idx) && idx > 0 ? idx : 1,
    environment:
      environment === "PRODUCTION" || environment === "SANDBOX"
        ? environment
        : "SANDBOX",
  };
}

/**
 * PhonePe credentials for a society: PaymentMethod row first, then env fallback.
 */
export async function getPhonePeConfig(societyId: string): Promise<PhonePeConfig | null> {
  const fromDb = await getPhonePeConfigFromDb(societyId);
  if (fromDb) return fromDb;
  return getEnvPhonePeConfig();
}

/**
 * Initiate a PhonePe Standard Pay API request.
 * Returns the redirect URL and transaction ID.
 */
export async function initiatePhonePePayment(
  societyId: string,
  params: {
    amount: number; // in paise
    merchantTransactionId: string;
    merchantUserId: string;
    callbackUrl: string;
    redirectUrl: string;
  },
): Promise<{ redirectUrl: string; merchantTransactionId: string } | null> {
  const config = await getPhonePeConfig(societyId);
  if (!config) return null;

  const payload = {
    merchantId: config.merchantId,
    merchantTransactionId: params.merchantTransactionId,
    merchantUserId: params.merchantUserId,
    amount: params.amount,
    redirectUrl: params.redirectUrl,
    redirectMode: "REDIRECT",
    callbackUrl: params.callbackUrl,
    paymentInstrument: { type: "PAY_PAGE" },
  };

  const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64");
  const checksum =
    crypto
      .createHash("sha256")
      .update(base64Payload + "/pg/v1/pay" + config.saltKey)
      .digest("hex") + `###${config.saltIndex}`;

  const baseUrl = BASE_URLS[config.environment];

  try {
    const response = await fetch(`${baseUrl}/pg/v1/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
      },
      body: JSON.stringify({ request: base64Payload }),
    });

    const data = (await response.json()) as {
      success: boolean;
      data?: { instrumentResponse?: { redirectInfo?: { url: string } } };
    };

    if (data.success && data.data?.instrumentResponse?.redirectInfo?.url) {
      return {
        redirectUrl: data.data.instrumentResponse.redirectInfo.url,
        merchantTransactionId: params.merchantTransactionId,
      };
    }

    logger.warn({ data }, "[phonepe] payment initiation failed");
    return null;
  } catch (error) {
    logger.error({ err: error }, "[phonepe] payment initiation error");
    return null;
  }
}

/**
 * Check PhonePe transaction status. Always returns a structured result (never null).
 */
export async function checkPhonePeStatus(
  societyId: string,
  merchantTransactionId: string,
): Promise<PhonePeStatusResult> {
  const config = await getPhonePeConfig(societyId);
  if (!config) {
    return buildPhonePeStatusUnavailable("PhonePe is not configured for this society");
  }

  const path = `/pg/v1/status/${config.merchantId}/${merchantTransactionId}`;
  const checksum =
    crypto
      .createHash("sha256")
      .update(path + config.saltKey)
      .digest("hex") + `###${config.saltIndex}`;

  const baseUrl = BASE_URLS[config.environment];

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
        "X-MERCHANT-ID": config.merchantId,
      },
    });

    if (response.status === 204 || response.status === 404) {
      return buildPhonePeStatusPending(
        response.status === 404 ? "Transaction not found at PhonePe yet" : "PhonePe has no status yet (pending)",
        response.status,
      );
    }

    const raw = await response.text();
    if (!raw.trim()) {
      logger.warn(
        { merchantTransactionId, httpStatus: response.status },
        "[phonepe] status check empty body",
      );
      return buildPhonePeStatusPending("Empty response from PhonePe status API", response.status);
    }

    let data: Parameters<typeof classifyPhonePeGatewayPayload>[0];
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      logger.error(
        { merchantTransactionId, httpStatus: response.status, raw: raw.slice(0, 200) },
        "[phonepe] status check non-JSON body",
      );
      return {
        ...buildPhonePeStatusUnavailable("Invalid JSON from PhonePe status API"),
        httpStatus: response.status,
        gatewayReachable: true,
      };
    }

    const classified = classifyPhonePeGatewayPayload(data);
    return {
      ...classified,
      gatewayReachable: true,
      httpStatus: response.status,
      detail: data.message,
    };
  } catch (error) {
    logger.error({ err: error, merchantTransactionId }, "[phonepe] status check error");
    return buildPhonePeStatusUnavailable(
      error instanceof Error ? error.message : "PhonePe status request failed",
    );
  }
}

/**
 * Verify the X-VERIFY header from a PhonePe server-to-server callback.
 * PhonePe sends: SHA256(base64Response + "/pg/v1/pay" + saltKey) + "###" + saltIndex
 */
export async function verifyPhonePeCallback(
  societyId: string,
  xVerifyHeader: string,
  responseBase64: string,
): Promise<boolean> {
  const config = await getPhonePeConfig(societyId);
  if (!config) return false;

  const expectedChecksum =
    crypto
      .createHash("sha256")
      .update(responseBase64 + "/pg/v1/pay" + config.saltKey)
      .digest("hex") + `###${config.saltIndex}`;

  const expected = Buffer.from(expectedChecksum, "utf8");
  const received = Buffer.from(xVerifyHeader, "utf8");
  if (expected.length !== received.length) return false;
  try {
    return crypto.timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

/**
 * Check if PhonePe is configured for a society (enabled PaymentMethod or global env).
 * Returns true only if usable credentials are available (i.e. not still encrypted).
 */
export async function isPhonePeConfiguredForSociety(societyId: string): Promise<boolean> {
  const config = await getPhonePeConfig(societyId);
  return config !== null;
}

/** Display name when exposing PhonePe via env-only (no DB row). */
export function getEnvPhonePeDisplayName(): string {
  const name = process.env.PHONEPE_DISPLAY_NAME?.trim();
  return name && name.length > 0 ? name : "PhonePe";
}
