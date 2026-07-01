import type { PaymentMethodType } from "@prisma/client";
import { encryptSecret, decryptSecret, isEncrypted } from "../../lib/paymentSecrets";
import { resolveUpiPayUriFromPayload } from "../../lib/buildUpiPaymentIntent";

/** Fields that contain secrets and should be encrypted at rest / masked for display. */
const SECRET_FIELDS: Record<string, string[]> = {
  RAZORPAY: ["keySecret", "webhookSecret"],
  PHONEPE: ["saltKey", "clientSecret"],
};

/** Mask a string with "***" (for admin view of secret fields). */
const MASKED = "***";

/**
 * Mask secret fields for admin viewing (replace with "***").
 * Non-secret fields are returned as-is.
 */
export function sanitizeConfigForAdmin(
  type: PaymentMethodType,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const secrets = SECRET_FIELDS[type];
  if (!secrets) return { ...config };

  const out = { ...config };
  for (const field of secrets) {
    if (out[field] && typeof out[field] === "string") {
      out[field] = MASKED;
    }
  }

  if (type === "UPI_QR" && !out.upiPayUri && typeof config.upiPayload === "string") {
    const resolved = resolveUpiPayUriFromPayload(config.upiPayload);
    if (resolved) out.upiPayUri = resolved;
  }

  return out;
}

/**
 * Strip secrets entirely for resident view.
 * Bank account numbers are partially masked (show last 4 digits).
 */
export function sanitizeConfigForResident(
  type: PaymentMethodType,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...config };

  // Strip all secret fields
  const secrets = SECRET_FIELDS[type];
  if (secrets) {
    for (const field of secrets) {
      delete out[field];
    }
  }

  // Additionally strip Razorpay keyId from resident view
  if (type === "RAZORPAY") {
    delete out.keyId;
    delete out.currency;
  }

  // Bank account number is shown in full so residents can use it for payment

  if (type === "UPI_QR") {
    delete out.upiPayload;
    if (!out.upiPayUri && typeof config.upiPayload === "string" && config.upiPayload.trim()) {
      const resolved = resolveUpiPayUriFromPayload(config.upiPayload);
      if (resolved) out.upiPayUri = resolved;
    }
  }

  return out;
}

/**
 * Encrypt secret fields before saving to database.
 */
export function encryptConfigSecrets(
  type: PaymentMethodType,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const secrets = SECRET_FIELDS[type];
  if (!secrets) return config;

  const out = { ...config };
  for (const field of secrets) {
    const val = out[field];
    if (val && typeof val === "string" && !isEncrypted(val)) {
      out[field] = encryptSecret(val);
    }
  }
  return out;
}

/**
 * Decrypt secret fields when reading from database (for internal use).
 */
export function decryptConfigSecrets(
  type: PaymentMethodType,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const secrets = SECRET_FIELDS[type];
  if (!secrets) return config;

  const out = { ...config };
  for (const field of secrets) {
    const val = out[field];
    if (val && typeof val === "string" && isEncrypted(val)) {
      out[field] = decryptSecret(val);
    }
  }
  return out;
}

/**
 * Merge a partial config update with existing config.
 * If a secret field value is "***", keep the existing encrypted value.
 */
export function mergeConfigUpdate(
  type: PaymentMethodType,
  existingConfig: Record<string, unknown>,
  newConfig: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existingConfig, ...newConfig };

  // If secret field is "***", keep existing
  const secrets = SECRET_FIELDS[type];
  if (secrets) {
    for (const field of secrets) {
      if (merged[field] === MASKED) {
        merged[field] = existingConfig[field];
      }
    }
  }

  return merged;
}
