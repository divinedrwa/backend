import { Router } from "express";
import { PaymentMethodType, Prisma, UserRole } from "@prisma/client";
import Razorpay from "razorpay";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { upiQrImageMemory } from "../../lib/upiQrUpload";
import { uploadUpiQrImageBuffer } from "../../services/cloudinaryUpiQr";
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

      const encryptedConfig = encryptConfigSecrets(type, config);

      const method = await prisma.paymentMethod.create({
        data: {
          societyId,
          type,
          displayName,
          isEnabled,
          sortOrder,
          config: encryptedConfig as Prisma.InputJsonValue,
        },
      });

      return res.status(201).json({
        method: {
          ...method,
          config: sanitizeConfigForAdmin(method.type, method.config as Record<string, unknown>),
        },
      });
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
      if (isEnabled !== undefined) data.isEnabled = isEnabled;
      if (sortOrder !== undefined) data.sortOrder = sortOrder;

      if (config) {
        const merged = mergeConfigUpdate(
          existing.type,
          existing.config as Record<string, unknown>,
          config,
        );
        data.config = encryptConfigSecrets(existing.type, merged) as Prisma.InputJsonValue;
      }

      const method = await prisma.paymentMethod.update({
        where: { id },
        data,
      });

      return res.json({
        method: {
          ...method,
          config: sanitizeConfigForAdmin(method.type, method.config as Record<string, unknown>),
        },
      });
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
        where: { bankAccountId: existing.legacyBankAccountId },
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
 * PATCH /api/payment-methods/reorder — bulk update sortOrder.
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

      const url = await uploadUpiQrImageBuffer(req.file.buffer, societyId);

      const method = await prisma.paymentMethod.update({
        where: { id },
        data: {
          config: { ...(existing.config as Record<string, unknown>), qrCodeUrl: url } as Prisma.InputJsonValue,
        },
      });

      return res.json({
        method: {
          ...method,
          config: sanitizeConfigForAdmin(method.type, method.config as Record<string, unknown>),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

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

      const sanitized = methods.map((m) => ({
        id: m.id,
        type: m.type,
        displayName: m.displayName,
        sortOrder: m.sortOrder,
        config: sanitizeConfigForResident(m.type, m.config as Record<string, unknown>),
      }));

      return res.json({ methods: sanitized });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
