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
  classifyPhonePeV2StatusPayload,
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

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/** V1 config — deprecated salt-key based auth. */
export type PhonePeConfig = {
  merchantId: string;
  saltKey: string;
  saltIndex: number;
  environment: "SANDBOX" | "PRODUCTION";
};

/** V2 config — OAuth token-based auth (current). */
export type PhonePeV2Config = {
  clientId: string;
  clientSecret: string;
  clientVersion: string;
  environment: "SANDBOX" | "PRODUCTION";
};

/** Resolved config — either V2 (preferred) or V1 fallback. */
export type PhonePeResolvedConfig =
  | { version: "v2"; v2: PhonePeV2Config; _source: "db" | "env" }
  | { version: "v1"; v1: PhonePeConfig; _source: "db" | "env" };

// ---------------------------------------------------------------------------
// Base URLs
// ---------------------------------------------------------------------------

const V1_BASE_URLS = {
  SANDBOX: "https://api-preprod.phonepe.com/apis/pg-sandbox",
  PRODUCTION: "https://api.phonepe.com/apis/hermes",
} as const;

const V2_BASE_URLS = {
  SANDBOX: "https://api-preprod.phonepe.com/apis/pg-sandbox",
  PRODUCTION: "https://api.phonepe.com/apis/pg",
} as const;

function parsePhonePeEnvironment(raw: string | undefined): "SANDBOX" | "PRODUCTION" {
  const v = (raw ?? "SANDBOX").toUpperCase();
  return v === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
}

// ---------------------------------------------------------------------------
// V2 OAuth Token cache
// ---------------------------------------------------------------------------

type CachedToken = { accessToken: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

async function fetchPhonePeAuthToken(v2: PhonePeV2Config): Promise<string | null> {
  const cacheKey = `${v2.clientId}:${v2.environment}`;
  const cached = tokenCache.get(cacheKey);
  // Refresh 60s before expiry
  if (cached && cached.expiresAt > Date.now() / 1000 + 60) {
    return cached.accessToken;
  }

  const baseUrl = V2_BASE_URLS[v2.environment];
  const url = `${baseUrl}/v1/oauth/token`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: v2.clientId,
        client_version: v2.clientVersion,
        client_secret: v2.clientSecret,
        grant_type: "client_credentials",
      }).toString(),
    });

    const rawText = await response.text();
    let data: {
      access_token?: string;
      expires_at?: number;
      token_type?: string;
    };
    try {
      data = JSON.parse(rawText);
    } catch {
      logger.error(
        { httpStatus: response.status, rawText: rawText.slice(0, 500) },
        "[phonepe-v2] token response non-JSON",
      );
      return null;
    }

    if (!data.access_token) {
      logger.error(
        { httpStatus: response.status, rawText: rawText.slice(0, 500) },
        "[phonepe-v2] token fetch failed — no access_token",
      );
      return null;
    }

    const expiresAt = data.expires_at ?? Math.floor(Date.now() / 1000) + 900;
    tokenCache.set(cacheKey, { accessToken: data.access_token, expiresAt });

    logger.info(
      { environment: v2.environment, tokenType: data.token_type, expiresAt },
      "[phonepe-v2] auth token fetched",
    );
    return data.access_token;
  } catch (error) {
    logger.error({ err: error }, "[phonepe-v2] token fetch error");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/** Global V2 credentials from environment. */
function getEnvPhonePeV2Config(): PhonePeV2Config | null {
  const clientId = process.env.PHONEPE_CLIENT_ID?.trim();
  const clientSecret = process.env.PHONEPE_CLIENT_SECRET?.trim();
  const clientVersion = process.env.PHONEPE_CLIENT_VERSION?.trim();
  if (!clientId || !clientSecret || !clientVersion) return null;
  return {
    clientId,
    clientSecret,
    clientVersion,
    environment: parsePhonePeEnvironment(process.env.PHONEPE_ENVIRONMENT),
  };
}

/** Global V1 credentials from environment (Render / local .env). */
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
  return getEnvPhonePeV2Config() !== null || getEnvPhonePeConfig() !== null;
}

async function getPhonePeConfigFromDb(societyId: string): Promise<PhonePeResolvedConfig | null> {
  const method = await prisma.paymentMethod.findFirst({
    where: {
      societyId,
      type: PaymentMethodType.PHONEPE,
      isEnabled: true,
    },
  });

  if (!method) return null;

  let config: Record<string, unknown>;
  try {
    config = decryptConfigSecrets(method.type, method.config as Record<string, unknown>);
  } catch (err) {
    logger.error(
      { err, societyId },
      "[phonepe] failed to decrypt society PhonePe config — falling back to env",
    );
    return null;
  }

  const env =
    config.environment === "PRODUCTION" || config.environment === "SANDBOX"
      ? config.environment
      : "SANDBOX";

  // Check for V2 credentials first
  if (config.clientId && config.clientSecret && config.clientVersion) {
    return {
      version: "v2",
      v2: {
        clientId: config.clientId as string,
        clientSecret: config.clientSecret as string,
        clientVersion: config.clientVersion as string,
        environment: env,
      },
      _source: "db",
    };
  }

  // Fall back to V1
  const { merchantId, saltKey, saltIndex } = config;
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
    version: "v1",
    v1: {
      merchantId: merchantId as string,
      saltKey: saltKey as string,
      saltIndex: Number.isFinite(idx) && idx > 0 ? idx : 1,
      environment: env,
    },
    _source: "db",
  };
}

/**
 * Resolved PhonePe config for a society.
 * Priority: DB V2 → DB V1 → Env V2 → Env V1.
 */
export async function resolvePhonePeConfig(societyId: string): Promise<PhonePeResolvedConfig | null> {
  const fromDb = await getPhonePeConfigFromDb(societyId);
  if (fromDb) return fromDb;

  const v2Env = getEnvPhonePeV2Config();
  if (v2Env) return { version: "v2", v2: v2Env, _source: "env" };

  const v1Env = getEnvPhonePeConfig();
  if (v1Env) return { version: "v1", v1: v1Env, _source: "env" };

  return null;
}

/** Backward-compatible alias used by existing callers. */
export async function getPhonePeConfig(societyId: string): Promise<(PhonePeConfig & { _source: "db" | "env" }) | null> {
  const resolved = await resolvePhonePeConfig(societyId);
  if (!resolved) return null;
  if (resolved.version === "v1") return { ...resolved.v1, _source: resolved._source };
  // V2 doesn't have merchantId/saltKey, but callers needing V1 config won't work.
  // Return null so they fall through to V2-specific code paths.
  return null;
}

// ---------------------------------------------------------------------------
// Initiate payment — V2 or V1
// ---------------------------------------------------------------------------

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
  const resolved = await resolvePhonePeConfig(societyId);
  if (!resolved) return null;

  if (resolved.version === "v2") {
    return initiatePhonePePaymentV2(resolved.v2, params);
  }
  return initiatePhonePePaymentV1(resolved.v1, params, resolved._source);
}

async function initiatePhonePePaymentV2(
  config: PhonePeV2Config,
  params: {
    amount: number;
    merchantTransactionId: string;
    merchantUserId: string;
    callbackUrl: string;
    redirectUrl: string;
  },
): Promise<{ redirectUrl: string; merchantTransactionId: string } | null> {
  const token = await fetchPhonePeAuthToken(config);
  if (!token) {
    logger.error("[phonepe-v2] cannot initiate — failed to obtain auth token");
    return null;
  }

  const baseUrl = V2_BASE_URLS[config.environment];
  const body = {
    merchantOrderId: params.merchantTransactionId,
    amount: params.amount,
    paymentFlow: {
      type: "PG_CHECKOUT",
      merchantUrls: {
        redirectUrl: params.redirectUrl,
      },
    },
    metaInfo: {
      udf1: params.merchantUserId,
    },
  };

  try {
    const response = await fetch(`${baseUrl}/checkout/v2/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `O-Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const rawText = await response.text();
    let data: {
      orderId?: string;
      state?: string;
      redirectUrl?: string;
      expireAt?: number;
      code?: string;
      message?: string;
    };
    try {
      data = JSON.parse(rawText);
    } catch {
      logger.error(
        { merchantOrderId: params.merchantTransactionId, httpStatus: response.status, rawText: rawText.slice(0, 500) },
        "[phonepe-v2] initiate returned non-JSON body",
      );
      return null;
    }

    logger.info(
      {
        merchantOrderId: params.merchantTransactionId,
        amount: params.amount,
        httpStatus: response.status,
        state: data.state,
        orderId: data.orderId,
        hasRedirectUrl: !!data.redirectUrl,
        redirectUrl: data.redirectUrl ?? null,
        code: data.code,
        message: data.message,
        environment: config.environment,
        apiVersion: "v2",
        redirectUrlSent: params.redirectUrl,
      },
      "[phonepe-v2] initiate response",
    );

    if (data.redirectUrl) {
      return {
        redirectUrl: data.redirectUrl,
        merchantTransactionId: params.merchantTransactionId,
      };
    }

    logger.warn(
      { code: data.code, message: data.message, httpStatus: response.status, fullResponse: rawText.slice(0, 1000) },
      "[phonepe-v2] payment initiation failed — no redirect URL",
    );
    return null;
  } catch (error) {
    logger.error({ err: error }, "[phonepe-v2] payment initiation error");
    return null;
  }
}

async function initiatePhonePePaymentV1(
  config: PhonePeConfig,
  params: {
    amount: number;
    merchantTransactionId: string;
    merchantUserId: string;
    callbackUrl: string;
    redirectUrl: string;
  },
  source: "db" | "env",
): Promise<{ redirectUrl: string; merchantTransactionId: string } | null> {
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

  const baseUrl = V1_BASE_URLS[config.environment];

  try {
    const response = await fetch(`${baseUrl}/pg/v1/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VERIFY": checksum,
      },
      body: JSON.stringify({ request: base64Payload }),
    });

    const rawText = await response.text();
    let data: {
      success: boolean;
      code?: string;
      message?: string;
      data?: { instrumentResponse?: { redirectInfo?: { url: string } } };
    };
    try {
      data = JSON.parse(rawText);
    } catch {
      logger.error(
        { merchantTransactionId: params.merchantTransactionId, httpStatus: response.status, rawText: rawText.slice(0, 500) },
        "[phonepe-v1] initiate returned non-JSON body",
      );
      return null;
    }

    const redirectUrl = data.data?.instrumentResponse?.redirectInfo?.url;

    logger.info(
      {
        merchantTransactionId: params.merchantTransactionId,
        amount: params.amount,
        httpStatus: response.status,
        success: data.success,
        code: data.code,
        message: data.message,
        redirectUrl: redirectUrl ?? null,
        callbackUrl: params.callbackUrl,
        merchantRedirectUrl: params.redirectUrl,
        environment: config.environment,
        merchantId: config.merchantId,
        configSource: source,
        apiVersion: "v1",
        baseUrl,
      },
      "[phonepe-v1] initiate response",
    );

    if (data.success && redirectUrl) {
      return {
        redirectUrl,
        merchantTransactionId: params.merchantTransactionId,
      };
    }

    logger.warn(
      { code: data.code, message: data.message, httpStatus: response.status, fullResponse: rawText.slice(0, 1000) },
      "[phonepe-v1] payment initiation failed",
    );
    return null;
  } catch (error) {
    logger.error({ err: error }, "[phonepe-v1] payment initiation error");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Check status — V2 or V1
// ---------------------------------------------------------------------------

export async function checkPhonePeStatus(
  societyId: string,
  merchantTransactionId: string,
): Promise<PhonePeStatusResult> {
  const resolved = await resolvePhonePeConfig(societyId);
  if (!resolved) {
    return buildPhonePeStatusUnavailable("PhonePe is not configured for this society");
  }

  if (resolved.version === "v2") {
    return checkPhonePeStatusV2(resolved.v2, merchantTransactionId);
  }
  return checkPhonePeStatusV1(resolved.v1, merchantTransactionId);
}

async function checkPhonePeStatusV2(
  config: PhonePeV2Config,
  merchantOrderId: string,
): Promise<PhonePeStatusResult> {
  const token = await fetchPhonePeAuthToken(config);
  if (!token) {
    return buildPhonePeStatusUnavailable("Failed to obtain PhonePe auth token");
  }

  const baseUrl = V2_BASE_URLS[config.environment];
  const url = `${baseUrl}/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status?details=false&errorContext=true`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `O-Bearer ${token}`,
      },
    });

    if (response.status === 404) {
      return buildPhonePeStatusPending("Order not found at PhonePe yet", response.status);
    }

    const rawText = await response.text();
    if (!rawText.trim()) {
      return buildPhonePeStatusPending("Empty response from PhonePe V2 status API", response.status);
    }

    let data: {
      orderId?: string;
      state?: string;
      amount?: number;
      errorCode?: string;
      detailedErrorCode?: string;
      code?: string;
      message?: string;
      paymentDetails?: Array<{
        transactionId?: string;
        state?: string;
        amount?: number;
      }>;
      errorContext?: {
        errorCode?: string;
        description?: string;
      };
    };
    try {
      data = JSON.parse(rawText);
    } catch {
      logger.error(
        { merchantOrderId, httpStatus: response.status, rawText: rawText.slice(0, 200) },
        "[phonepe-v2] status check non-JSON body",
      );
      return {
        ...buildPhonePeStatusUnavailable("Invalid JSON from PhonePe V2 status API"),
        httpStatus: response.status,
        gatewayReachable: true,
      };
    }

    const classified = classifyPhonePeV2StatusPayload(data);
    return {
      ...classified,
      gatewayReachable: true,
      httpStatus: response.status,
      detail: data.message ?? data.errorContext?.description,
    };
  } catch (error) {
    logger.error({ err: error, merchantOrderId }, "[phonepe-v2] status check error");
    return buildPhonePeStatusUnavailable(
      error instanceof Error ? error.message : "PhonePe V2 status request failed",
    );
  }
}

async function checkPhonePeStatusV1(
  config: PhonePeConfig,
  merchantTransactionId: string,
): Promise<PhonePeStatusResult> {
  const path = `/pg/v1/status/${config.merchantId}/${merchantTransactionId}`;
  const checksum =
    crypto
      .createHash("sha256")
      .update(path + config.saltKey)
      .digest("hex") + `###${config.saltIndex}`;

  const baseUrl = V1_BASE_URLS[config.environment];

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
        "[phonepe-v1] status check empty body",
      );
      return buildPhonePeStatusPending("Empty response from PhonePe status API", response.status);
    }

    let data: Parameters<typeof classifyPhonePeGatewayPayload>[0];
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      logger.error(
        { merchantTransactionId, httpStatus: response.status, raw: raw.slice(0, 200) },
        "[phonepe-v1] status check non-JSON body",
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
    logger.error({ err: error, merchantTransactionId }, "[phonepe-v1] status check error");
    return buildPhonePeStatusUnavailable(
      error instanceof Error ? error.message : "PhonePe status request failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------

/**
 * V1 callback verification — X-VERIFY header with SHA256 checksum.
 */
export async function verifyPhonePeCallback(
  societyId: string,
  xVerifyHeader: string,
  responseBase64: string,
): Promise<boolean> {
  const resolved = await resolvePhonePeConfig(societyId);
  if (!resolved || resolved.version !== "v1") return false;
  const config = resolved.v1;

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
 * V2 webhook verification — Authorization header is SHA256(username:password).
 * Credentials come from env or could be stored per-society.
 */
export function verifyPhonePeV2Webhook(authHeader: string | undefined): boolean {
  const username = process.env.PHONEPE_WEBHOOK_USERNAME?.trim();
  const password = process.env.PHONEPE_WEBHOOK_PASSWORD?.trim();
  if (!username || !password || !authHeader) return false;

  const expectedHash = crypto.createHash("sha256").update(`${username}:${password}`).digest("hex");

  const expected = Buffer.from(expectedHash, "utf8");
  const received = Buffer.from(authHeader, "utf8");
  if (expected.length !== received.length) return false;
  try {
    return crypto.timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Utility exports
// ---------------------------------------------------------------------------

/**
 * Check if PhonePe is configured for a society (V2 or V1).
 */
export async function isPhonePeConfiguredForSociety(societyId: string): Promise<boolean> {
  const config = await resolvePhonePeConfig(societyId);
  return config !== null;
}

/** Display name when exposing PhonePe via env-only (no DB row). */
export function getEnvPhonePeDisplayName(): string {
  const name = process.env.PHONEPE_DISPLAY_NAME?.trim();
  return name && name.length > 0 ? name : "PhonePe";
}

/** Returns the API version being used for a society. */
export async function getPhonePeApiVersion(societyId: string): Promise<"v2" | "v1" | null> {
  const config = await resolvePhonePeConfig(societyId);
  return config?.version ?? null;
}
