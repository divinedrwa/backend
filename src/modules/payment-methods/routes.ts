import { Router } from "express";
import { PaymentMethodType, Prisma, UserRole } from "@prisma/client";
import Razorpay from "razorpay";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { upiQrImageMemory } from "../../lib/upiQrUpload";
import {
  createPaymentMethodSchema,
  updatePaymentMethodSchema,
  reorderPaymentMethodsSchema,
} from "./schemas";
import {
  sanitizeConfigForAdmin,
  sanitizeConfigForResident,
  encryptConfigSecrets,
  decryptConfigSecrets,
  mergeConfigUpdate,
} from "./service";
import {
  getEnvPhonePeDisplayName,
  isPhonePeConfigured,
} from "../../services/phonepe-billing";
import {
  isSandboxSociety,
  validateGatewayConfigForSandbox,
} from "../../lib/sandboxSociety";
import { isUpiQrConfigReady } from "../../lib/decodeUpiQrImage";
import {
  enrichUpiVpaConfig,
  isUpiVpaConfigReady,
  upiVpaValidationMessage,
} from "../../lib/validateUpiVpa";
import { processUpiQrImageUpload } from "./upiQrUpload.service";

const router = Router();

router.use(requireAuth);

// ── ADMIN ROUTES ─────────────────────────────────────────────────────

/**
 * GET /api/payment-methods — list all methods for the society (admin).
 */
router.get("/", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const methods = await prisma.paymentMethod.findMany({
      where: { societyId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    const sanitized = methods.map((m) => ({
      ...m,
      config: sanitizeConfigForAdmin(m.type, m.config as Record<string, unknown>),
    }));

    return res.json({ methods: sanitized });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/payment-methods — create a new payment method.
 */
router.post(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(createPaymentMethodSchema),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const { type, config, displayName, isEnabled, sortOrder } = req.body;

      let finalConfig = config as Record<string, unknown>;
      let validation: { message: string; vpa?: string } | undefined;

      if (type === PaymentMethodType.UPI_VPA) {
        try {
          finalConfig = enrichUpiVpaConfig(finalConfig);
          validation = {
            vpa: finalConfig.vpa as string,
            message: upiVpaValidationMessage(finalConfig.vpa as string),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Invalid UPI VPA";
          return res.status(400).json({ message });
        }
      }

      let enabled = isEnabled ?? true;
      if (type === PaymentMethodType.UPI_QR && !isUpiQrConfigReady(finalConfig)) {
        enabled = false;
      }
      if (type === PaymentMethodType.UPI_VPA && !isUpiVpaConfigReady(finalConfig)) {
        enabled = false;
      }

      if (
        type === PaymentMethodType.RAZORPAY ||
        type === PaymentMethodType.PHONEPE
      ) {
        if (await isSandboxSociety(societyId)) {
          const sandboxIssue = validateGatewayConfigForSandbox(type, finalConfig);
          if (sandboxIssue) {
            return res.status(400).json(sandboxIssue);
          }
        }
      }

      const encryptedConfig = encryptConfigSecrets(type, finalConfig);

      const method = await prisma.paymentMethod.create({
        data: {
          societyId,
          type,
          displayName,
          isEnabled: enabled,
          sortOrder,
          config: encryptedConfig as Prisma.InputJsonValue,
        },
      });

      return res.status(201).json({
        method: {
          ...method,
          config: sanitizeConfigForAdmin(method.type, method.config as Record<string, unknown>),
        },
        ...(validation ? { validation } : {}),
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * PATCH /api/payment-methods/reorder — bulk update sortOrder.
 * Must be registered before PATCH /:id so "reorder" isn't captured as an id.
 */
router.patch(
  "/reorder",
  requireRole(UserRole.ADMIN),
  validateBody(reorderPaymentMethodsSchema),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const { order } = req.body;

      await prisma.$transaction(
        order.map((item: { id: string; sortOrder: number }) =>
          prisma.paymentMethod.updateMany({
            where: { id: item.id, societyId },
            data: { sortOrder: item.sortOrder },
          }),
        ),
      );

      return res.json({ message: "Reordered" });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * PATCH /api/payment-methods/:id — update a payment method.
 */
router.patch(
  "/:id",
  requireRole(UserRole.ADMIN),
  validateBody(updatePaymentMethodSchema),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const { id } = req.params;
      const { displayName, isEnabled, sortOrder, config } = req.body;

      const existing = await prisma.paymentMethod.findFirst({
        where: { id, societyId },
      });
      if (!existing) {
        return res.status(404).json({ message: "Payment method not found" });
      }

      const data: Record<string, unknown> = {};
      if (displayName !== undefined) data.displayName = displayName;

      let mergedConfig: Record<string, unknown> | undefined;
      if (config) {
        mergedConfig = mergeConfigUpdate(
          existing.type,
          existing.config as Record<string, unknown>,
          config,
        );
        if (existing.type === PaymentMethodType.UPI_VPA) {
          try {
            mergedConfig = enrichUpiVpaConfig(
              mergedConfig,
              existing.config as Record<string, unknown>,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : "Invalid UPI VPA";
            return res.status(400).json({ message });
          }
        }
        data.config = encryptConfigSecrets(existing.type, mergedConfig) as Prisma.InputJsonValue;
      }

      const configToValidate =
        mergedConfig ?? (existing.config as Record<string, unknown>);
      if (
        existing.type === PaymentMethodType.RAZORPAY ||
        existing.type === PaymentMethodType.PHONEPE
      ) {
        if (await isSandboxSociety(societyId)) {
          const sandboxIssue = validateGatewayConfigForSandbox(
            existing.type,
            configToValidate,
          );
          if (sandboxIssue) {
            return res.status(400).json(sandboxIssue);
          }
        }
      }

      if (isEnabled !== undefined) {
        const cfg =
          mergedConfig ?? (existing.config as Record<string, unknown>);
        if (isEnabled && existing.type === PaymentMethodType.UPI_QR && !isUpiQrConfigReady(cfg)) {
          return res.status(400).json({
            message:
              "Upload a valid bank UPI QR code before enabling. The QR is decoded automatically on upload.",
          });
        }
        if (isEnabled && existing.type === PaymentMethodType.UPI_VPA && !isUpiVpaConfigReady(cfg)) {
          return res.status(400).json({
            message:
              "Enter a valid UPI VPA before enabling. VPA format is verified when you save.",
          });
        }
        data.isEnabled = isEnabled;
      }
      if (sortOrder !== undefined) data.sortOrder = sortOrder;

      const method = await prisma.paymentMethod.update({
        where: { id },
        data,
      });

      const response: Record<string, unknown> = {
        method: {
          ...method,
          config: sanitizeConfigForAdmin(method.type, method.config as Record<string, unknown>),
        },
      };
      if (
        existing.type === PaymentMethodType.UPI_VPA &&
        config &&
        isUpiVpaConfigReady(method.config as Record<string, unknown>)
      ) {
        response.validation = {
          vpa: (method.config as Record<string, unknown>).vpa,
          message: upiVpaValidationMessage(
            String((method.config as Record<string, unknown>).vpa),
          ),
        };
      }

      return res.json(response);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * DELETE /api/payment-methods/:id — delete a payment method.
 */
router.delete("/:id", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    const existing = await prisma.paymentMethod.findFirst({
      where: { id, societyId },
    });
    if (!existing) {
      return res.status(404).json({ message: "Payment method not found" });
    }

    // Guard: don't delete BANK_TRANSFER if it has linked maintenance payments
    if (existing.type === PaymentMethodType.BANK_TRANSFER && existing.legacyBankAccountId) {
      const linkedPayments = await prisma.maintenancePayment.count({
        where: { bankAccountId: existing.legacyBankAccountId, societyId },
      });
      if (linkedPayments > 0) {
        return res.status(409).json({
          message: `Cannot delete: ${linkedPayments} payment(s) are linked to this bank account`,
        });
      }
    }

    await prisma.paymentMethod.delete({ where: { id } });
    return res.json({ message: "Payment method deleted" });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/payment-methods/:id/upload-qr — upload QR image for UPI_QR type.
 */
router.post(
  "/:id/upload-qr",
  requireRole(UserRole.ADMIN),
  upiQrImageMemory.single("qrImage"),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const { id } = req.params;

      const existing = await prisma.paymentMethod.findFirst({
        where: { id, societyId, type: PaymentMethodType.UPI_QR },
      });
      if (!existing) {
        return res.status(404).json({ message: "UPI QR payment method not found" });
      }
      if (!req.file) {
        return res.status(400).json({ message: "No image file provided" });
      }

      let uploadResult;
      try {
        uploadResult = await processUpiQrImageUpload(
          req.file.buffer,
          societyId,
          existing.config as Record<string, unknown>,
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to read UPI QR code from image";
        return res.status(400).json({ message });
      }

      const method = await prisma.paymentMethod.update({
        where: { id },
        data: {
          config: uploadResult.config as Prisma.InputJsonValue,
        },
      });

      return res.json({
        method: {
          ...method,
          config: sanitizeConfigForAdmin(method.type, method.config as Record<string, unknown>),
        },
        validation: uploadResult.validation,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/payment-methods/:id/verify-vpa — validate UPI VPA for UPI_VPA type.
 */
router.post("/:id/verify-vpa", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    const existing = await prisma.paymentMethod.findFirst({
      where: { id, societyId, type: PaymentMethodType.UPI_VPA },
    });
    if (!existing) {
      return res.status(404).json({ message: "UPI VPA payment method not found" });
    }

    const vpaRaw = (existing.config as Record<string, unknown>).vpa;
    if (typeof vpaRaw !== "string" || !vpaRaw.trim()) {
      return res.status(400).json({ message: "Enter a UPI VPA before verifying" });
    }

    let enriched: Record<string, unknown>;
    try {
      enriched = enrichUpiVpaConfig(
        { vpa: vpaRaw },
        existing.config as Record<string, unknown>,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid UPI VPA";
      return res.status(400).json({ message });
    }

    const method = await prisma.paymentMethod.update({
      where: { id },
      data: { config: enriched as Prisma.InputJsonValue },
    });

    return res.json({
      method: {
        ...method,
        config: sanitizeConfigForAdmin(method.type, method.config as Record<string, unknown>),
      },
      validation: {
        valid: true,
        vpa: enriched.vpa,
        message: upiVpaValidationMessage(String(enriched.vpa)),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/payment-methods/:id/test-connection — test Razorpay/PhonePe credentials.
 */
router.post("/:id/test-connection", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    const method = await prisma.paymentMethod.findFirst({
      where: { id, societyId },
    });
    if (!method) {
      return res.status(404).json({ message: "Payment method not found" });
    }

    const config = decryptConfigSecrets(method.type, method.config as Record<string, unknown>);

    if (method.type === PaymentMethodType.RAZORPAY) {
      const keyId = config.keyId as string;
      const keySecret = config.keySecret as string;
      if (!keyId || !keySecret) {
        return res.status(400).json({ message: "Missing Razorpay credentials" });
      }
      try {
        const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
        // Fetch a small list of orders to verify credentials
        await rzp.orders.all({ count: 1 });
        return res.json({ success: true, message: "Razorpay credentials verified" });
      } catch {
        return res.json({ success: false, message: "Razorpay authentication failed — check key ID and secret" });
      }
    }

    if (method.type === PaymentMethodType.PHONEPE) {
      const { merchantId, saltKey, environment } = config as Record<string, string>;
      if (!merchantId || !saltKey || !environment) {
        return res.json({ success: false, message: "Missing PhonePe credentials" });
      }
      try {
        // Call PhonePe status API with a dummy txn ID.
        // A 4xx (transaction not found) means credentials are valid.
        const { checkPhonePeStatus } = await import("../../services/phonepe-billing");
        const result = await checkPhonePeStatus(societyId, `test_conn_${Date.now()}`);
        // If we get a response (even with PAYMENT_NOT_FOUND), the credentials work
        if (result !== null) {
          return res.json({ success: true, message: "PhonePe credentials verified" });
        }
        return res.json({ success: false, message: "PhonePe authentication failed — check merchant ID and salt key" });
      } catch {
        return res.json({ success: false, message: "PhonePe API connection failed — check credentials and environment" });
      }
    }

    return res.status(400).json({ message: "Test connection is only available for RAZORPAY and PHONEPE" });
  } catch (error) {
    next(error);
  }
});

// ── RESIDENT ROUTE ───────────────────────────────────────────────────

/**
 * GET /api/residents/payment-methods — list enabled methods for residents.
 */
export const residentPaymentMethodsRouter = Router();
residentPaymentMethodsRouter.use(requireAuth);

residentPaymentMethodsRouter.get(
  "/payment-methods",
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const methods = await prisma.paymentMethod.findMany({
        where: { societyId, isEnabled: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      });

      const sanitized = methods
        .filter((m) => {
          const cfg = m.config as Record<string, unknown>;
          if (m.type === PaymentMethodType.UPI_QR) return isUpiQrConfigReady(cfg);
          if (m.type === PaymentMethodType.UPI_VPA) return isUpiVpaConfigReady(cfg);
          return true;
        })
        .map((m) => ({
          id: m.id,
          type: m.type,
          displayName: m.displayName,
          sortOrder: m.sortOrder,
          config: sanitizeConfigForResident(m.type, m.config as Record<string, unknown>),
        }));

      // Env-only PhonePe — only inject if no PhonePe row exists at all in the DB
      // (neither enabled nor disabled). If admin created one and disabled it, respect that.
      if (isPhonePeConfigured() && !sanitized.some((m) => m.type === PaymentMethodType.PHONEPE)) {
        const phonePeRowExists = await prisma.paymentMethod.findFirst({
          where: { societyId, type: PaymentMethodType.PHONEPE },
          select: { id: true },
        });
        if (!phonePeRowExists) {
          sanitized.push({
            id: "env-default-phonepe",
            type: PaymentMethodType.PHONEPE,
            displayName: getEnvPhonePeDisplayName(),
            sortOrder: 999,
            config: {},
          });
        }
      }

      return res.json({ methods: sanitized });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
