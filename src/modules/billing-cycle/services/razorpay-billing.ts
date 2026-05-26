import Razorpay from "razorpay";
import { PaymentMethodType } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { logger } from "../../../lib/logger";
import { isEncrypted } from "../../../lib/paymentSecrets";
import { decryptConfigSecrets } from "../../payment-methods/service";

let client: Razorpay | null = null;

function getClient(): Razorpay | null {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) return null;
  if (!client) {
    client = new Razorpay({ key_id: id, key_secret: secret });
  }
  return client;
}

export function isRazorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export async function createMaintenanceOrder(params: {
  amountPaise: number;
  receipt: string;
  notes: Record<string, string>;
}) {
  const rzp = getClient();
  if (!rzp) {
    throw Object.assign(new Error("Razorpay not configured"), { code: "GATEWAY_MISSING" });
  }
  const order = await rzp.orders.create({
    amount: Math.max(100, Math.round(params.amountPaise)),
    currency: process.env.RAZORPAY_CURRENCY ?? "INR",
    receipt: params.receipt.slice(0, 40),
    notes: params.notes,
  });
  return order;
}

export function getPublishableKey(): string | undefined {
  return process.env.RAZORPAY_KEY_ID;
}

// ── Per-society Razorpay helpers ─────────────────────────────────────

/**
 * Get a Razorpay client for a specific society. Checks PaymentMethod table
 * first, falls back to global env var client.
 */
export async function getClientForSociety(societyId: string): Promise<Razorpay | null> {
  const method = await prisma.paymentMethod.findFirst({
    where: {
      societyId,
      type: PaymentMethodType.RAZORPAY,
      isEnabled: true,
    },
  });

  if (method) {
    const config = decryptConfigSecrets(method.type, method.config as Record<string, unknown>);
    const keyId = config.keyId as string;
    const keySecret = config.keySecret as string;
    if (keyId && keySecret) {
      if (isEncrypted(keySecret)) {
        logger.error("Razorpay keySecret is still encrypted — PAYMENT_SECRETS_KEY env var is missing or wrong");
        return null;
      }
      return new Razorpay({ key_id: keyId, key_secret: keySecret });
    }
  }

  // Fallback to global env var client
  return getClient();
}

/**
 * Check if Razorpay is configured for a given society
 * (either per-society PaymentMethod with usable credentials, or global env vars).
 */
export async function isRazorpayConfiguredForSociety(societyId: string): Promise<boolean> {
  const client = await getClientForSociety(societyId);
  return client !== null;
}

/**
 * Get the publishable key for a society's Razorpay integration.
 */
export async function getPublishableKeyForSociety(societyId: string): Promise<string | undefined> {
  const method = await prisma.paymentMethod.findFirst({
    where: {
      societyId,
      type: PaymentMethodType.RAZORPAY,
      isEnabled: true,
    },
  });

  if (method) {
    const config = method.config as Record<string, unknown>;
    return config.keyId as string | undefined;
  }

  return getPublishableKey();
}

/**
 * Create a Razorpay order using per-society keys (with env var fallback).
 */
export async function createMaintenanceOrderForSociety(params: {
  societyId: string;
  amountPaise: number;
  receipt: string;
  notes: Record<string, string>;
}) {
  const rzp = await getClientForSociety(params.societyId);
  if (!rzp) {
    throw Object.assign(new Error("Razorpay not configured"), { code: "GATEWAY_MISSING" });
  }

  // Check for per-society currency preference
  let currency = process.env.RAZORPAY_CURRENCY ?? "INR";
  const method = await prisma.paymentMethod.findFirst({
    where: {
      societyId: params.societyId,
      type: PaymentMethodType.RAZORPAY,
      isEnabled: true,
    },
  });
  if (method) {
    const config = method.config as Record<string, unknown>;
    if (typeof config.currency === "string") currency = config.currency;
  }

  const order = await rzp.orders.create({
    amount: Math.max(100, Math.round(params.amountPaise)),
    currency,
    receipt: params.receipt.slice(0, 40),
    notes: params.notes,
  });
  return order;
}

/**
 * Get the webhook secret for a society (per-society or global).
 */
export async function getWebhookSecretForSociety(societyId: string): Promise<string | undefined> {
  const method = await prisma.paymentMethod.findFirst({
    where: {
      societyId,
      type: PaymentMethodType.RAZORPAY,
      isEnabled: true,
    },
  });

  if (method) {
    const config = decryptConfigSecrets(method.type, method.config as Record<string, unknown>);
    const webhookSecret = config.webhookSecret as string | undefined;
    if (webhookSecret) return webhookSecret;
  }

  return process.env.RAZORPAY_WEBHOOK_SECRET;
}

type RazorpayPaymentItem = { id?: string; status?: string; amount?: number };

/**
 * Poll Razorpay order + payments. Always returns a structured result (never null).
 */
export async function checkRazorpayOrderStatus(
  societyId: string,
  orderId: string,
): Promise<import("../../../services/razorpay-status").RazorpayStatusResult> {
  const {
    buildRazorpayStatusPending,
    buildRazorpayStatusUnavailable,
    classifyRazorpayOrderAndPayments,
  } = await import("../../../services/razorpay-status");

  const rzp = await getClientForSociety(societyId);
  if (!rzp) {
    return buildRazorpayStatusUnavailable("Razorpay is not configured for this society");
  }

  try {
    const order = (await rzp.orders.fetch(orderId)) as { status?: string };
    let payments: RazorpayPaymentItem[] = [];
    try {
      const paymentList = (await rzp.orders.fetchPayments(orderId)) as {
        items?: RazorpayPaymentItem[];
      };
      payments = paymentList.items ?? [];
    } catch (payErr) {
      logger.warn({ err: payErr, orderId }, "[razorpay] fetchPayments failed — using order status only");
    }

    const classified = classifyRazorpayOrderAndPayments({
      orderStatus: order.status,
      payments,
    });

    const captured = payments.find((p) => (p.status ?? "").toLowerCase() === "captured");
    return {
      ...classified,
      gatewayReachable: true,
      amountPaise: captured?.amount,
      gatewayTransactionId: classified.gatewayTransactionId ?? captured?.id,
    };
  } catch (error) {
    const err = error as { statusCode?: number; error?: { code?: string; description?: string } };
    if (err.statusCode === 400 || err.error?.code === "BAD_REQUEST_ERROR") {
      return buildRazorpayStatusPending(
        err.error?.description ?? "Order not found or not ready at Razorpay",
      );
    }
    logger.error({ err: error, orderId }, "[razorpay] order status check error");
    return buildRazorpayStatusUnavailable(
      error instanceof Error ? error.message : "Razorpay status request failed",
    );
  }
}
