import crypto from "crypto";
import { PaymentMethodType } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { decryptConfigSecrets } from "../modules/payment-methods/service";
import { logger } from "../lib/logger";

type PhonePeConfig = {
  merchantId: string;
  saltKey: string;
  saltIndex: number;
  environment: "SANDBOX" | "PRODUCTION";
};

const BASE_URLS = {
  SANDBOX: "https://api-preprod.phonepe.com/apis/pg-sandbox",
  PRODUCTION: "https://api.phonepe.com/apis/hermes",
} as const;

export async function getPhonePeConfig(societyId: string): Promise<PhonePeConfig | null> {
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

  return {
    merchantId: merchantId as string,
    saltKey: saltKey as string,
    saltIndex: (saltIndex as number) ?? 1,
    environment: (environment as "SANDBOX" | "PRODUCTION") ?? "SANDBOX",
  };
}

/**
 * Initiate a PhonePe Standard Pay API request.
 * Returns the redirect URL and transaction ID.
 *
 * NOTE: Full integration (webhook handler, Flutter SDK) is a separate follow-up.
 * This creates the service skeleton for test-connection and future use.
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
 * Check the status of a PhonePe transaction.
 */
export async function checkPhonePeStatus(
  societyId: string,
  merchantTransactionId: string,
): Promise<{ success: boolean; state: string; amount?: number } | null> {
  const config = await getPhonePeConfig(societyId);
  if (!config) return null;

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

    const data = (await response.json()) as {
      success: boolean;
      code: string;
      data?: { state: string; amount?: number };
    };

    return {
      success: data.success,
      state: data.data?.state ?? data.code,
      amount: data.data?.amount,
    };
  } catch (error) {
    logger.error({ err: error }, "[phonepe] status check error");
    return null;
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

  return expectedChecksum === xVerifyHeader;
}

/**
 * Check if PhonePe is enabled and configured for a society.
 */
export async function isPhonePeConfiguredForSociety(societyId: string): Promise<boolean> {
  const config = await getPhonePeConfig(societyId);
  return config !== null;
}
