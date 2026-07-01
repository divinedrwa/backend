import { z } from "zod";
import { UPI_VPA_REGEX } from "../../lib/validateUpiVpa";

const bankTransferConfigSchema = z.object({
  bankName: z.string().trim().min(1),
  accountNumber: z.string().trim().min(5),
  ifscCode: z
    .string()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "IFSC must match format like ABCD0123456"),
  accountHolderName: z.string().trim().min(1),
  accountType: z.enum(["SAVINGS", "CURRENT"]),
});

const upiVpaConfigSchema = z.object({
  vpa: z
    .string()
    .trim()
    .min(3)
    .regex(UPI_VPA_REGEX, "Invalid UPI VPA format (use name@bank, e.g. society@okhdfc)"),
  vpaValidatedAt: z.string().datetime().optional(),
});

const upiQrConfigSchema = z.object({
  qrCodeUrl: z.string().url().optional(),
  vpa: z.string().min(3).regex(/@/, "VPA must contain @").optional(),
  payeeName: z.string().trim().min(1).optional().nullable(),
  upiPayload: z.string().optional(),
  upiPayUri: z.string().optional().nullable(),
  hasFixedAmount: z.boolean().optional(),
  fixedAmount: z.string().optional().nullable(),
  qrValidatedAt: z.string().datetime().optional(),
});

const razorpayConfigSchema = z.object({
  keyId: z.string().min(1),
  keySecret: z.string().min(1),
  webhookSecret: z.string().optional(),
  currency: z.string().length(3).default("INR"),
  /** Platform fee % on maintenance due (charged on top at checkout). */
  feePercent: z.number().min(0).max(100).optional(),
  /** GST % on platform fee (default 18 if omitted). */
  feeGstPercent: z.number().min(0).max(100).optional(),
  /** Fixed platform fee in rupees (added before GST). */
  feeFixedRupees: z.number().min(0).optional(),
});

const phonepeConfigSchema = z.object({
  merchantId: z.string().min(1),
  saltKey: z.string().min(1),
  saltIndex: z.number().int().min(1).default(1),
  environment: z.enum(["SANDBOX", "PRODUCTION"]),
});

// ── Create schema (discriminated union) ──────────────────────────────

const baseCreate = {
  displayName: z.string().trim().min(1).max(100),
  isEnabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
};

export const createPaymentMethodSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("BANK_TRANSFER"), config: bankTransferConfigSchema, ...baseCreate }),
  z.object({ type: z.literal("UPI_VPA"), config: upiVpaConfigSchema, ...baseCreate }),
  z.object({ type: z.literal("UPI_QR"), config: upiQrConfigSchema, ...baseCreate }),
  z.object({ type: z.literal("RAZORPAY"), config: razorpayConfigSchema, ...baseCreate }),
  z.object({ type: z.literal("PHONEPE"), config: phonepeConfigSchema, ...baseCreate }),
]);

// ── Update schema ────────────────────────────────────────────────────

export const updatePaymentMethodSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  isEnabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  config: z.record(z.unknown()).optional(),
});

// ── Reorder schema ───────────────────────────────────────────────────

export const reorderPaymentMethodsSchema = z.object({
  order: z.array(
    z.object({
      id: z.string(),
      sortOrder: z.number().int().min(0),
    }),
  ).min(1),
});

export type CreatePaymentMethodInput = z.infer<typeof createPaymentMethodSchema>;
export type UpdatePaymentMethodInput = z.infer<typeof updatePaymentMethodSchema>;
