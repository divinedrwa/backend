import { Router } from "express";
import { z } from "zod";
import {
  BillingCycleStatus,
  BillingPaymentSource,
  BillingUserPaymentStatus,
  UserRole,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { requireAuth, requireRole, isAdminLikeRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { deriveCycleStatusUtc } from "./domain/cycleStatus";
import { computeAmountDueForCycle } from "./domain/amountDue";
import {
  computeUserBillingLedger,
} from "./services/cycle-service";
import {
  createMaintenanceOrderForSociety,
  getPublishableKeyForSociety,
  isRazorpayConfiguredForSociety,
} from "./services/razorpay-billing";
import { ensureMaintenanceCollectionForBillingCycle } from "./billing-collection-link";
import { isGatewayLedgerSynced, reconcileRazorpayFromPoll } from "./gateway-payment-settle";
import {
  computeRazorpayCheckoutBreakup,
  getRazorpayGatewayFeeConfigForSociety,
} from "./services/razorpay-gateway-fee";
import { computeCycleAdjustedDue, computePayAllQuote } from "./services/gateway-pay-all";

/** Razorpay orders expire in ~15 min. After this threshold a PENDING order
 *  whose gateway status is also still PENDING is treated as abandoned. */
const STALE_ORDER_MINUTES = 10;

/**
 * Reconcile an existing PENDING Razorpay order before deciding whether to
 * return it (still active → reuse) or fall through (failed/stale → new order).
 *
 * Returns a partial JSON response object when the order should be reused.
 * Returns `null` when the order is confirmed FAILED or stale (>10 min,
 * gateway still PENDING) → caller should fall through to create a fresh order.
 */
async function reconcileExistingRazorpayOrder(
  societyId: string,
  orderId: string,
  paymentId: string,
  totalDue: number,
): Promise<{ autoSettled?: boolean } | null> {
  try {
    const poll = await reconcileRazorpayFromPoll(societyId, orderId);

    if (poll.status === BillingUserPaymentStatus.SUCCESS) {
      return { autoSettled: true };
    }

    if (poll.status === BillingUserPaymentStatus.FAILED || poll.outcome === "failed") {
      return null;
    }
  } catch (err) {
    logger.warn({ err, orderId }, "[razorpay] reconcile of existing order failed");
  }

  // Still PENDING — check staleness
  try {
    const row = await prisma.userCyclePayment.findFirst({
      where: { paymentGatewayOrderId: orderId },
      select: { updatedAt: true },
    });
    if (row) {
      const ageMinutes = (Date.now() - row.updatedAt.getTime()) / 60_000;
      if (ageMinutes > STALE_ORDER_MINUTES) {
        logger.info(
          { orderId, ageMinutes: Math.round(ageMinutes) },
          "[razorpay] stale PENDING order — allowing fresh initiation",
        );
        return null;
      }
    }
  } catch {
    // If we can't check staleness, fall through to return the existing order
  }

  // Fresh PENDING order — reuse it
  return {};
}

const router = Router();

const createOrderSchema = z
  .object({
    cycleId: z.string().min(1).optional(),
    payAllPending: z.boolean().optional(),
    idempotencyKey: z.string().min(8).max(120).optional(),
  })
  .refine((d) => d.payAllPending === true || Boolean(d.cycleId), {
    message: "cycleId is required unless payAllPending is true",
  });

router.post(
  "/payments/create-order",
  requireAuth,
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  validateBody(createOrderSchema),
  async (req, res, _next) => {
    try {
      const auth = req.auth!;
      const body = req.body as z.infer<typeof createOrderSchema>;
      const { idempotencyKey, payAllPending } = body;

      // Server-side idempotency: if the same key was already used for a
      // PENDING order, return that order to prevent duplicate gateway charges.
      if (idempotencyKey) {
        const idempotentRow = await prisma.userCyclePayment.findFirst({
          where: {
            userId: auth.userId,
            idempotencyKey,
            paymentStatus: BillingUserPaymentStatus.PENDING,
            paymentGatewayOrderId: { not: null },
          },
        });
        if (idempotentRow?.paymentGatewayOrderId) {
          const reconciled = await reconcileExistingRazorpayOrder(
            auth.societyId,
            idempotentRow.paymentGatewayOrderId,
            idempotentRow.id,
            Number(idempotentRow.amountPaid),
          );
          if (reconciled?.autoSettled) {
            res.status(200).json({
              orderId: idempotentRow.paymentGatewayOrderId,
              paymentId: idempotentRow.id,
              totalDue: Number(idempotentRow.amountPaid),
              existingOrder: true,
              autoSettled: true,
              idempotent: true,
            });
            return;
          }
          if (reconciled !== null) {
            // Fresh PENDING — return existing order for SDK reuse
            const feeConfigIdem = await getRazorpayGatewayFeeConfigForSociety(auth.societyId);
            const breakupIdem = computeRazorpayCheckoutBreakup(Number(idempotentRow.amountPaid), feeConfigIdem);
            res.status(200).json({
              orderId: idempotentRow.paymentGatewayOrderId,
              amountPaise: breakupIdem.totalPayablePaise,
              currency: "INR",
              key: await getPublishableKeyForSociety(auth.societyId),
              paymentId: idempotentRow.id,
              totalDue: Number(idempotentRow.amountPaid),
              existingOrder: true,
              idempotent: true,
            });
            return;
          }
          // reconciled === null → failed or stale, fall through to create new order
        }
      }

      const payAllQuote = payAllPending
        ? await computePayAllQuote(auth.societyId, auth.userId)
        : null;
      if (payAllPending && !payAllQuote) {
        res.status(400).json({ message: "No pending dues to pay", code: "NOTHING_DUE" });
        return;
      }

      const cycleId = payAllQuote?.anchorCycleId ?? body.cycleId!;

      const cycle = await prisma.billingCycle.findFirst({
        where: { id: cycleId, societyId: auth.societyId },
      });
      if (!cycle) {
        res.status(404).json({ message: "Cycle not found" });
        return;
      }

      if (!payAllPending) {
        const serverStatus = deriveCycleStatusUtc(new Date(), cycle.paymentStartDate, cycle.paymentEndDate);
        if (serverStatus === BillingCycleStatus.UPCOMING) {
          res.status(400).json({ message: "Cycle is not yet open for payment", code: "CYCLE_NOT_OPEN" });
          return;
        }
      }

      const ledger = await computeUserBillingLedger(auth.societyId, auth.userId);
      const currentLedger = ledger.cycles.find((row) => row.cycleId === cycleId);
      const balanceBefore = currentLedger?.balanceBefore ?? 0;
      const due = computeAmountDueForCycle(
        cycle,
        new Date(),
        Boolean(
          await prisma.billingLateFeeWaiver.findUnique({
            where: { cycleId_userId: { cycleId, userId: auth.userId } },
          }),
        ),
      );
      const adjustedDue = payAllQuote
        ? payAllQuote.maintenanceTotal
        : await computeCycleAdjustedDue(auth.societyId, auth.userId, cycle, currentLedger);
      if (adjustedDue <= 0) {
        const paymentRow = await prisma.userCyclePayment.upsert({
          where: { userId_cycleId: { userId: auth.userId, cycleId } },
          create: {
            userId: auth.userId,
            cycleId,
            amountPaid: 0,
            paymentStatus: BillingUserPaymentStatus.SUCCESS,
            source: BillingPaymentSource.CASH_MANUAL,
            manualMarkedByAdminId: null,
            paidAt: new Date(),
          },
          update: {
            amountPaid: 0,
            paymentStatus: BillingUserPaymentStatus.SUCCESS,
            paidAt: new Date(),
          },
        });
        res.status(201).json({
          orderId: null,
          amountPaise: 0,
          currency: "INR",
          key: await getPublishableKeyForSociety(auth.societyId),
          paymentId: paymentRow.id,
          totalDue: 0,
          unadjustedDue: due.totalDue,
          availableCreditApplied: Math.max(0, Math.min(balanceBefore, due.totalDue)),
          autoSettledFromCredit: true,
        });
        return;
      }

      const existing = await prisma.userCyclePayment.findUnique({
        where: { userId_cycleId: { userId: auth.userId, cycleId } },
      });
      if (
        existing?.paymentStatus === BillingUserPaymentStatus.SUCCESS
      ) {
        res.status(409).json({ message: "Already paid for this cycle", code: "ALREADY_PAID" });
        return;
      }

      // Prevent race: if a PENDING payment already has a gateway order,
      // reconcile with gateway first, then decide whether to reuse or create new.
      if (
        existing?.paymentStatus === BillingUserPaymentStatus.PENDING &&
        existing.paymentGatewayOrderId
      ) {
        const reconciled = await reconcileExistingRazorpayOrder(
          auth.societyId,
          existing.paymentGatewayOrderId,
          existing.id,
          adjustedDue,
        );
        if (reconciled?.autoSettled) {
          res.status(200).json({
            orderId: existing.paymentGatewayOrderId,
            paymentId: existing.id,
            totalDue: adjustedDue,
            existingOrder: true,
            autoSettled: true,
          });
          return;
        }
        if (reconciled !== null) {
          // Fresh PENDING — return existing order for SDK reuse
          const feeConfigExisting = await getRazorpayGatewayFeeConfigForSociety(auth.societyId);
          const breakupExisting = computeRazorpayCheckoutBreakup(adjustedDue, feeConfigExisting);
          res.status(200).json({
            orderId: existing.paymentGatewayOrderId,
            amountPaise: breakupExisting.totalPayablePaise,
            currency: "INR",
            key: await getPublishableKeyForSociety(auth.societyId),
            paymentId: existing.id,
            totalDue: adjustedDue,
            unadjustedDue: due.totalDue,
            availableCreditApplied: Math.max(0, Math.min(balanceBefore, due.totalDue)),
            autoSettledFromCredit: false,
            existingOrder: true,
          });
          return;
        }
        // reconciled === null → failed or stale, fall through to create new order
      }

      if (!(await isRazorpayConfiguredForSociety(auth.societyId))) {
        res.status(503).json({
          message: "Online payments are not configured",
          code: "PAYMENT_GATEWAY_UNAVAILABLE",
        });
        return;
      }

      try {
        await prisma.$transaction(async (tx) => {
          await ensureMaintenanceCollectionForBillingCycle(tx, cycleId);
        });
      } catch (linkErr) {
        logger.warn({ err: linkErr, cycleId }, "[razorpay] billing→collection pre-link failed");
      }

      const feeConfig = await getRazorpayGatewayFeeConfigForSociety(auth.societyId);
      const breakup = computeRazorpayCheckoutBreakup(adjustedDue, feeConfig);

      const receipt = `mb_${cycle.cycleKey}_${auth.userId}`.slice(0, 40);
      const order = await createMaintenanceOrderForSociety({
        societyId: auth.societyId,
        amountPaise: breakup.totalPayablePaise,
        receipt,
        notes: {
          societyId: auth.societyId,
          cycleId,
          userId: auth.userId,
          maintenanceAmountPaise: String(breakup.maintenanceAmountPaise),
          platformFeePaise: String(breakup.platformFeePaise),
          platformFeeGstPaise: String(breakup.platformFeeGstPaise),
          ...(payAllPending ? { payAllPending: "true" } : {}),
        },
      });

      const paymentRow = await prisma.userCyclePayment.upsert({
        where: { userId_cycleId: { userId: auth.userId, cycleId } },
        create: {
          userId: auth.userId,
          cycleId,
          amountPaid: breakup.maintenanceAmount,
          paymentStatus: BillingUserPaymentStatus.PENDING,
          paymentGatewayOrderId: order.id,
          idempotencyKey: idempotencyKey ?? null,
        },
        update: {
          amountPaid: breakup.maintenanceAmount,
          paymentStatus: BillingUserPaymentStatus.PENDING,
          paymentGatewayOrderId: order.id,
          idempotencyKey: idempotencyKey ?? undefined,
        },
      });

      await prisma.billingPaymentLog.create({
        data: {
          societyId: auth.societyId,
          userId: auth.userId,
          cycleId,
          status: "create_order",
          requestPayload: {
            orderId: order.id,
            maintenanceAmount: breakup.maintenanceAmount,
            platformFee: breakup.platformFee,
            platformFeeGst: breakup.platformFeeGst,
            totalPayable: breakup.totalPayable,
            payAllPending: payAllPending === true,
            pendingCycleCount: payAllQuote?.pendingCount,
          } as object,
        },
      });

      res.status(201).json({
        orderId: order.id,
        amountPaise: order.amount,
        currency: order.currency,
        key: await getPublishableKeyForSociety(auth.societyId),
        paymentId: paymentRow.id,
        totalDue: breakup.maintenanceAmount,
        maintenanceAmount: breakup.maintenanceAmount,
        platformFee: breakup.platformFee,
        platformFeeGst: breakup.platformFeeGst,
        totalPayable: breakup.totalPayable,
        payAllPending: payAllPending === true,
        pendingCycleCount: payAllQuote?.pendingCount ?? 1,
        unadjustedDue: due.totalDue,
        availableCreditApplied: Math.max(0, Math.min(balanceBefore, due.totalDue)),
      });
    } catch (e: unknown) {
      const err = e as { code?: string; statusCode?: number; error?: { description?: string } };
      if (err.code === "GATEWAY_MISSING") {
        res.status(503).json({ message: "Gateway not configured", code: "PAYMENT_GATEWAY_UNAVAILABLE" });
        return;
      }
      // Razorpay SDK / API errors — log detail, return user-safe message
      logger.error({ err: e }, "Razorpay order creation failed");
      const detail = err.error?.description ?? (e instanceof Error ? e.message : "Unknown error");
      res.status(502).json({
        message: `Payment gateway error: ${detail}`,
        code: "GATEWAY_ERROR",
      });
    }
  }
);

router.get(
  "/payments/razorpay/status/:orderId",
  requireAuth,
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const { orderId } = req.params;

      const localRow = await prisma.userCyclePayment.findFirst({
        where: {
          paymentGatewayOrderId: orderId,
          cycle: { societyId: auth.societyId },
          ...(!isAdminLikeRole(auth.role) ? { userId: auth.userId } : {}),
        },
        select: {
          id: true,
          paymentStatus: true,
          userId: true,
          cycleId: true,
          amountPaid: true,
          cycle: { select: { societyId: true, id: true } },
        },
      });

      if (!localRow) {
        res.status(404).json({
          message: "Payment not found for this order",
          code: "PAYMENT_NOT_FOUND",
          status: "UNKNOWN",
          outcome: "unknown",
        });
        return;
      }

      let poll;
      try {
        poll = await reconcileRazorpayFromPoll(auth.societyId, orderId);
      } catch (reconcileErr) {
        logger.error({ err: reconcileErr, orderId }, "[razorpay status] unexpected reconcile error");
        res.status(200).json({
          status: localRow.paymentStatus,
          outcome: "reconcile_failed",
          razorpayState: "UNKNOWN",
          razorpayCode: null,
          razorpayAvailable: false,
          reconciled: false,
          paymentId: localRow.id,
          detail: reconcileErr instanceof Error ? reconcileErr.message : "Could not verify payment",
        });
        return;
      }
      const status =
        poll.status ?? localRow.paymentStatus ?? BillingUserPaymentStatus.PENDING;

      logger.info(
        {
          orderId,
          localStatus: localRow.paymentStatus,
          status,
          outcome: poll.outcome,
          razorpayState: poll.gateway.rawState,
          razorpayCode: poll.gateway.rawCode,
          reconciled: poll.reconciled,
        },
        "[razorpay status] poll result",
      );

      const ledgerSynced = await isGatewayLedgerSynced(
        {
          id: localRow.id,
          userId: localRow.userId,
          cycleId: localRow.cycleId,
          amountPaid: localRow.amountPaid,
          cycle: { societyId: localRow.cycle.societyId, id: localRow.cycle.id },
        },
        orderId,
      );

      res.json({
        status,
        outcome: poll.outcome,
        razorpayState: poll.gateway.rawState,
        razorpayCode: poll.gateway.rawCode ?? null,
        razorpayAvailable: poll.gateway.gatewayReachable,
        reconciled: poll.reconciled,
        ledgerSynced,
        paymentId: localRow.id,
        detail: poll.gateway.detail ?? null,
      });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
