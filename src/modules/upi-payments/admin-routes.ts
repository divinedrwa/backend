import { Router } from "express";
import { z } from "zod";
import { NotificationCategory, UpiPaymentStatus, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { notifyUser } from "../../services/notification.service";
import { recordPaymentAndSyncLedgers } from "../maintenance-payments/record-payment";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

// ---------------------------------------------------------------------------
// GET /api/upi-payments/pending — list submissions by status
// ---------------------------------------------------------------------------
router.get("/pending", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const status = (req.query.status as string) ?? "PENDING";
    const validStatuses = ["PENDING", "VERIFIED", "REJECTED"];
    const filterStatus = validStatuses.includes(status) ? status : "PENDING";

    const submissions = await prisma.upiPaymentSubmission.findMany({
      where: { societyId, status: filterStatus as UpiPaymentStatus },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        villa: { select: { id: true, villaNumber: true, block: true, ownerName: true } },
      },
      orderBy: { submittedAt: "desc" },
      take: 100,
    });
    return res.json({ submissions });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /api/upi-payments/:id/verify — admin verifies, triggers ledger sync
// ---------------------------------------------------------------------------
router.post("/:id/verify", async (req, res, next) => {
  try {
    const { societyId, userId: adminId } = req.auth!;
    const { id } = req.params;

    const submission = await prisma.upiPaymentSubmission.findFirst({
      where: { id, societyId, status: UpiPaymentStatus.PENDING },
    });
    if (!submission) {
      return res.status(404).json({ message: "Submission not found or already processed" });
    }

    // Detect multi-month "Pay All" payments: if the amount exceeds the
    // expected amount for the single cycle, the credit walker should
    // process all cycles so overpayment flows to subsequent months.
    const matchingCycle = await prisma.maintenanceCollectionCycle.findFirst({
      where: { societyId, periodMonth: submission.month, periodYear: submission.year },
      include: { snapshots: { where: { villaId: submission.villaId }, select: { expectedAmount: true } } },
    });
    const singleCycleExpected = matchingCycle?.snapshots?.[0]
      ? Number(matchingCycle.snapshots[0].expectedAmount)
      : 0;
    const isMultiMonth = Number(submission.amount) > singleCycleExpected && singleCycleExpected > 0;

    // Run payment recording inside transaction, then mark submission verified
    const result = await prisma.$transaction(
      async (tx) => {
        const payResult = await recordPaymentAndSyncLedgers(tx, {
          societyId,
          villaId: submission.villaId,
          month: submission.month,
          year: submission.year,
          amount: Number(submission.amount),
          paymentDate: new Date().toISOString(),
          paymentMode: "UPI",
          transactionId: submission.upiTransactionRef ?? undefined,
          recordedByUserId: adminId,
          auditAction: "VERIFY_UPI_PAYMENT",
          walkAllCycles: isMultiMonth,
        });

        const updated = await tx.upiPaymentSubmission.update({
          where: { id },
          data: {
            status: UpiPaymentStatus.VERIFIED,
            verifiedAt: new Date(),
            verifiedByAdminId: adminId,
          },
        });

        return { payment: payResult.payment, submission: updated };
      },
      {
        maxWait: 5000,
        timeout: 10000,
        isolationLevel: "Serializable",
      },
    );

    // Notify the submitting resident
    const verifyRemarkSuffix = submission.remark
      ? ` — ${submission.remark}`
      : ` for ${submission.month}/${submission.year}`;
    await notifyUser(
      submission.userId,
      {
        title: "UPI Payment Verified",
        body: `Your UPI payment of ₹${Number(submission.amount)}${verifyRemarkSuffix} has been verified.`,
        data: {
          type: "UPI_PAYMENT_VERIFIED",
          submissionId: submission.id,
        },
      },
      { category: NotificationCategory.PAYMENT },
    );

    return res.json({ payment: result.payment, submission: result.submission });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /api/upi-payments/:id/reject — admin rejects with reason
// ---------------------------------------------------------------------------
const rejectSchema = z.object({
  rejectionReason: z.string().trim().min(3).max(500),
});

router.post(
  "/:id/reject",
  validateBody(rejectSchema),
  async (req, res, next) => {
    try {
      const { societyId, userId: adminId } = req.auth!;
      const { id } = req.params;
      const { rejectionReason } = req.body;

      const submission = await prisma.upiPaymentSubmission.findFirst({
        where: { id, societyId, status: UpiPaymentStatus.PENDING },
      });
      if (!submission) {
        return res.status(404).json({ message: "Submission not found or already processed" });
      }

      const updated = await prisma.upiPaymentSubmission.update({
        where: { id },
        data: {
          status: UpiPaymentStatus.REJECTED,
          rejectionReason,
          verifiedAt: new Date(),
          verifiedByAdminId: adminId,
        },
      });

      // Notify the submitting resident
      await notifyUser(
        submission.userId,
        {
          title: "UPI Payment Rejected",
          body: `Your UPI payment of ₹${Number(submission.amount)} for ${submission.month}/${submission.year} was rejected: ${rejectionReason}`,
          data: {
            type: "UPI_PAYMENT_REJECTED",
            submissionId: submission.id,
          },
        },
        { category: NotificationCategory.PAYMENT },
      );

      return res.json({ submission: updated });
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/upi-payments/stats — counts by status
// ---------------------------------------------------------------------------
router.get("/stats", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const [pending, verified, rejected] = await Promise.all([
      prisma.upiPaymentSubmission.count({ where: { societyId, status: UpiPaymentStatus.PENDING } }),
      prisma.upiPaymentSubmission.count({ where: { societyId, status: UpiPaymentStatus.VERIFIED } }),
      prisma.upiPaymentSubmission.count({ where: { societyId, status: UpiPaymentStatus.REJECTED } }),
    ]);
    return res.json({ pending, verified, rejected });
  } catch (error) {
    next(error);
  }
});

export default router;
