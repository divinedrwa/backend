import { Router } from "express";
import { z } from "zod";
import { NotificationCategory, PaymentMethodType, UpiPaymentStatus, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { notifySociety } from "../../services/notification.service";

const router = Router();

router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/residents/upi-config — returns society UPI VPA + payee name
// Reads from PaymentMethod first, falls back to Society fields.
// ---------------------------------------------------------------------------
router.get(
  "/upi-config",
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const society = await prisma.society.findUnique({
        where: { id: societyId },
        select: { upiVpa: true, upiQrCodeUrl: true, name: true },
      });
      if (!society) {
        return res.status(404).json({ message: "Society not found" });
      }

      // Try PaymentMethod table first
      const methods = await prisma.paymentMethod.findMany({
        where: {
          societyId,
          type: { in: [PaymentMethodType.UPI_VPA, PaymentMethodType.UPI_QR] },
          isEnabled: true,
        },
      });

      let upiVpa: string | null = null;
      let upiQrCodeUrl: string | null = null;

      for (const m of methods) {
        const config = m.config as Record<string, unknown>;
        if (m.type === PaymentMethodType.UPI_VPA && typeof config.vpa === "string") {
          upiVpa = config.vpa;
        }
        if (m.type === PaymentMethodType.UPI_QR && typeof config.qrCodeUrl === "string") {
          upiQrCodeUrl = config.qrCodeUrl;
        }
      }

      // Fallback to Society fields if no PaymentMethod rows
      if (!upiVpa) upiVpa = society.upiVpa;
      if (!upiQrCodeUrl) upiQrCodeUrl = society.upiQrCodeUrl;

      return res.json({
        upiVpa,
        upiQrCodeUrl,
        payeeName: society.name,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/residents/upi-payment-submit — resident submits UPI payment claim
// ---------------------------------------------------------------------------
const submitSchema = z.object({
  amount: z.number().positive(),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020),
  upiTransactionRef: z.string().min(6).max(30).optional(),
  cycleId: z.string().optional(),
  remark: z.string().trim().max(500).optional(),
});

router.post(
  "/upi-payment-submit",
  requireRole(UserRole.RESIDENT),
  validateBody(submitSchema),
  async (req, res, next) => {
    try {
      const { societyId, userId, villaId } = req.auth!;
      if (!villaId) {
        return res.status(400).json({ message: "No villa assigned to your account" });
      }

      const { amount, month, year, upiTransactionRef, cycleId, remark } = req.body;

      // Duplicate check: same user, same month/year, still PENDING
      const existing = await prisma.upiPaymentSubmission.findFirst({
        where: {
          societyId,
          userId,
          month,
          year,
          status: UpiPaymentStatus.PENDING,
        },
      });
      if (existing) {
        return res.status(409).json({
          message: "You already have a pending UPI submission for this month",
          submission: existing,
        });
      }

      const submission = await prisma.upiPaymentSubmission.create({
        data: {
          societyId,
          userId,
          villaId,
          cycleId: cycleId ?? null,
          amount,
          upiTransactionRef: upiTransactionRef ?? null,
          remark: remark ?? null,
          month,
          year,
        },
      });

      // Notify all admins
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      const villa = await prisma.villa.findUnique({
        where: { id: villaId },
        select: { villaNumber: true },
      });

      const remarkSuffix = remark ? ` — ${remark}` : ` for ${month}/${year}`;
      await notifySociety(
        societyId,
        {
          title: "UPI Payment Submitted",
          body: `${user?.name ?? "Resident"} (Villa ${villa?.villaNumber ?? ""}) submitted ₹${amount} UPI payment${remarkSuffix}`,
          data: {
            type: "UPI_PAYMENT_SUBMITTED",
            submissionId: submission.id,
          },
        },
        UserRole.ADMIN,
        { category: NotificationCategory.PAYMENT },
      );

      return res.status(201).json({ submission });
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/residents/my-upi-payments — list own UPI submissions
// ---------------------------------------------------------------------------
router.get(
  "/my-upi-payments",
  requireRole(UserRole.RESIDENT),
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;
      const submissions = await prisma.upiPaymentSubmission.findMany({
        where: { userId, societyId },
        orderBy: { submittedAt: "desc" },
        take: 50,
      });
      return res.json({ submissions });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
