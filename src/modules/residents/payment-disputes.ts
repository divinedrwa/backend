import { Router } from "express";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { notifySocietyRoles } from "../../services/notification.service";
import { logger } from "../../lib/logger";

const router = Router();
router.use(requireAuth);
router.use(requireRole(UserRole.RESIDENT, UserRole.ADMIN));

const createDisputeSchema = z.object({
  reason: z.string().trim().min(5).max(200),
  residentNote: z.string().trim().max(4000).optional(),
  cycleKey: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  maintenancePaymentId: z.string().cuid().optional(),
  amount: z.number().positive().optional(),
});

router.get("/payment-disputes", async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const pagination = getPagination(req);

    const where = { societyId, userId };
    const [disputes, total] = await Promise.all([
      prisma.paymentDispute.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.paymentDispute.count({ where }),
    ]);

    res.json({ disputes, ...paginationMeta(total, disputes.length, pagination) });
  } catch (error) {
    next(error);
  }
});

router.post("/payment-disputes", validateBody(createDisputeSchema), async (req, res, next) => {
  try {
    const { userId, societyId, villaId } = req.auth!;
    const body = req.body as z.infer<typeof createDisputeSchema>;

    if (body.maintenancePaymentId) {
      const payment = await prisma.maintenancePayment.findFirst({
        where: { id: body.maintenancePaymentId, societyId, villaId: villaId ?? undefined },
      });
      if (!payment) {
        res.status(404).json({ message: "Payment not found for your villa" });
        return;
      }
    }

    const dispute = await prisma.paymentDispute.create({
      data: {
        societyId,
        userId,
        villaId,
        reason: body.reason,
        residentNote: body.residentNote,
        cycleKey: body.cycleKey,
        maintenancePaymentId: body.maintenancePaymentId,
        amount: body.amount,
      },
    });

    notifySocietyRoles({
      societyId,
      roles: [UserRole.ADMIN],
      title: "Payment dispute",
      body: `A resident reported: ${body.reason}`,
      data: { type: "PAYMENT_DISPUTE_OPENED", disputeId: dispute.id },
      category: "SYSTEM",
    }).catch((err) => logger.error(err, "payment dispute admin notify failed"));

    res.status(201).json({ dispute });
  } catch (error) {
    next(error);
  }
});

export default router;
