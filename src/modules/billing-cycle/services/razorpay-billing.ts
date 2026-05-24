import Razorpay from "razorpay";
import { PaymentMethodType } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
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
      return new Razorpay({ key_id: keyId, key_secret: keySecret });
    }
  }

  // Fallback to global env var client
  return getClient();
}

/**
 * Check if Razorpay is configured for a given society
 * (either per-society PaymentMethod or global env vars).
 */
export async function isRazorpayConfiguredForSociety(societyId: string): Promise<boolean> {
  const method = await prisma.paymentMethod.findFirst({
    where: {
      societyId,
      type: PaymentMethodType.RAZORPAY,
      isEnabled: true,
    },
    select: { id: true },
  });
  if (method) return true;
  return isRazorpayConfigured();
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
