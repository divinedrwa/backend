import { Router } from "express";
import { PaymentDisputeStatus, UserRole } from "@prisma/client";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { notifyUsers } from "../../services/notification.service";
import { logger } from "../../lib/logger";

const router = Router();
router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

const updateDisputeSchema = z.object({
  status: z.nativeEnum(PaymentDisputeStatus).optional(),
  adminNote: z.string().trim().max(4000).optional(),
});

router.get("/", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const pagination = getPagination(req);
    const status =
      typeof req.query.status === "string" && req.query.status.trim()
        ? (req.query.status.trim() as PaymentDisputeStatus)
        : undefined;

    const where = {
      societyId,
      ...(status ? { status } : {}),
    };

    const [disputes, total, openCount] = await Promise.all([
      prisma.paymentDispute.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, username: true } },
          villa: { select: { id: true, villaNumber: true, ownerName: true } },
          resolvedBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.paymentDispute.count({ where }),
      prisma.paymentDispute.count({
        where: {
          societyId,
          status: { in: [PaymentDisputeStatus.OPEN, PaymentDisputeStatus.IN_REVIEW] },
        },
      }),
    ]);

    res.json({
      disputes,
      openCount,
      ...paginationMeta(total, disputes.length, pagination),
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", validateBody(updateDisputeSchema), async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const adminId = req.auth!.userId;
    const { id } = req.params;
    const body = req.body as z.infer<typeof updateDisputeSchema>;

    const existing = await prisma.paymentDispute.findFirst({
      where: { id, societyId },
    });
    if (!existing) {
      res.status(404).json({ message: "Dispute not found" });
      return;
    }

    const terminal = new Set<PaymentDisputeStatus>([
      PaymentDisputeStatus.RESOLVED,
      PaymentDisputeStatus.REJECTED,
    ]);
    const nextStatus = body.status ?? existing.status;
    const dispute = await prisma.paymentDispute.update({
      where: { id },
      data: {
        ...(body.adminNote !== undefined ? { adminNote: body.adminNote } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.status && terminal.has(body.status)
          ? { resolvedAt: new Date(), resolvedById: adminId }
          : {}),
      },
      include: {
        user: { select: { id: true, name: true } },
        villa: { select: { villaNumber: true } },
      },
    });

    notifyUsers(
      [existing.userId],
      {
        title: "Payment dispute update",
        body:
          nextStatus === PaymentDisputeStatus.RESOLVED
            ? "Your payment dispute was resolved."
            : nextStatus === PaymentDisputeStatus.REJECTED
              ? "Your payment dispute was closed."
              : "Your payment dispute status was updated.",
        data: { type: "PAYMENT_DISPUTE_UPDATED", disputeId: id },
      },
      { category: "SYSTEM" },
    ).catch((err) => logger.error(err, "payment dispute notify failed"));

    res.json({ dispute });
  } catch (error) {
    next(error);
  }
});

export default router;
