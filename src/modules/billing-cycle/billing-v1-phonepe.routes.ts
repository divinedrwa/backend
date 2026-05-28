import { Router } from "express";
import { z } from "zod";
import {
  BillingCycleStatus,
  BillingUserPaymentStatus,
  UserRole,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { requireAuth, requireRole, isAdminLikeRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { deriveCycleStatusUtc } from "./domain/cycleStatus";
import { computeUserBillingLedger } from "./services/cycle-service";
import {
  initiatePhonePePayment,
  isPhonePeConfiguredForSociety,
} from "../../services/phonepe-billing";
import { computeCycleAdjustedDue, computePayAllQuote } from "./services/gateway-pay-all";
import { ensureMaintenanceCollectionForBillingCycle } from "./billing-collection-link";
import { isGatewayLedgerSynced, reconcilePhonePeFromPoll } from "./gateway-payment-settle";

function buildMerchantTransactionId(cycleKey: string, userId: string): string {
  const safeKey = cycleKey.replace(/[^a-zA-Z0-9]/g, "");
  const safeUser = userId.replace(/[^a-zA-Z0-9]/g, "").slice(-10);
  const suffix = Date.now().toString(36);
  return `pp${safeKey}${safeUser}${suffix}`.slice(0, 35);
}

/**
 * Fresh-order window: below this age, return the existing PENDING order
 * immediately for client-side polling WITHOUT calling PhonePe's status API.
 * This keeps the initiate endpoint fast (~100 ms vs ~5 s).
 */
const FRESH_ORDER_MINUTES = 25;

/**
 * After this age, a PENDING order is almost certainly abandoned.
 * If PhonePe STILL says PENDING at this point, allow creating a new order.
 * Between FRESH and MAX, if PhonePe says PENDING we keep the existing order
 * to protect against orphaning in-flight UPI payments.
 */
const MAX_PENDING_MINUTES = 60;

/**
 * Decide what to do with an existing PENDING PhonePe order.
 *
 * - **Fresh (< 25 min)**: return immediately for client polling (no gateway API call).
 * - **Stale (25–60 min)**: call PhonePe status; SUCCESS → autoSettled, FAILED → new,
 *   PENDING → keep existing (UPI can be slow).
 * - **Abandoned (> 60 min)**: call PhonePe status; SUCCESS → autoSettled, anything
 *   else → allow new order.
 *
 * Returns a response object when the caller should NOT create a new order.
 * Returns `null` when it's safe to create a fresh one.
 */
async function reconcileExistingOrder(
  societyId: string,
  merchantTransactionId: string,
  paymentId: string,
  totalDue: number,
  payAllPending?: boolean,
  pendingCycleCount?: number,
): Promise<Record<string, unknown> | null> {
  const extraFields = {
    ...(payAllPending != null && { payAllPending }),
    ...(pendingCycleCount != null && { pendingCycleCount }),
  };

  const makeExisting = (extra?: Record<string, unknown>) => ({
    merchantTransactionId,
    paymentId,
    totalDue,
    existingOrder: true,
    ...extraFields,
    ...extra,
  });

  // --- 1. Read the current row state ---
  const row = await prisma.userCyclePayment.findFirst({
    where: { paymentGatewayOrderId: merchantTransactionId },
    select: { updatedAt: true, paymentStatus: true },
  });

  if (!row) return null; // Row deleted or overwritten — create new

  // Already settled (e.g., webhook arrived) → tell client immediately
  if (row.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
    return makeExisting({ autoSettled: true });
  }

  // Already marked FAILED → safe to create new
  if (row.paymentStatus === BillingUserPaymentStatus.FAILED) {
    return null;
  }

  // --- 2. Decide based on age ---
  const ageMinutes = (Date.now() - row.updatedAt.getTime()) / 60_000;

  // Fresh PENDING order: return immediately for client-side polling.
  // Don't call PhonePe's status API — the client will poll the status
  // endpoint which handles full reconciliation.
  if (ageMinutes < FRESH_ORDER_MINUTES) {
    return makeExisting();
  }

  // --- 3. Stale or abandoned: check PhonePe to decide ---
  try {
    const poll = await reconcilePhonePeFromPoll(societyId, merchantTransactionId);

    if (poll.status === BillingUserPaymentStatus.SUCCESS) {
      return makeExisting({ autoSettled: true });
    }

    if (poll.status === BillingUserPaymentStatus.FAILED || poll.outcome === "failed") {
      // Terminal failure → safe to create new
      return null;
    }
  } catch (err) {
    logger.warn({ err, merchantTransactionId }, "[phonepe] reconcile of stale order failed");
    // Can't reach PhonePe → don't orphan the order, return for polling
    return makeExisting();
  }

  // PhonePe still says PENDING. If the order is very old (> 60 min),
  // it's almost certainly abandoned — allow a new order.
  if (ageMinutes > MAX_PENDING_MINUTES) {
    logger.info(
      { merchantTransactionId, ageMinutes: Math.round(ageMinutes) },
      "[phonepe] order exceeded max pending age — allowing fresh initiation",
    );
    return null;
  }

  // Between 25-60 min and PhonePe says PENDING → don't orphan (UPI can be slow)
  logger.info(
    { merchantTransactionId, ageMinutes: Math.round(ageMinutes) },
    "[phonepe] stale PENDING order but PhonePe not terminal — returning for polling",
  );
  return makeExisting();
}

const router = Router();

const phonePeInitiateSchema = z
  .object({
    cycleId: z.string().min(1).optional(),
    payAllPending: z.boolean().optional(),
    idempotencyKey: z.string().min(8).max(120).optional(),
  })
  .refine((d) => d.payAllPending === true || Boolean(d.cycleId), {
    message: "cycleId is required unless payAllPending is true",
  });

router.post(
  "/payments/phonepe/initiate",
  requireAuth,
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  validateBody(phonePeInitiateSchema),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const body = req.body as z.infer<typeof phonePeInitiateSchema>;
      const { idempotencyKey, payAllPending } = body;

      // Server-side idempotency: if the same key was already used for a
      // PENDING order, reconcile with PhonePe before deciding what to do.
      if (idempotencyKey) {
        const idempotentRow = await prisma.userCyclePayment.findFirst({
          where: {
            userId: auth.userId,
            idempotencyKey,
            paymentStatus: BillingUserPaymentStatus.PENDING,
            paymentGatewayOrderId: { not: null },
          },
          include: { cycle: { select: { societyId: true, id: true } } },
        });
        if (idempotentRow?.paymentGatewayOrderId) {
          const resolved = await reconcileExistingOrder(
            auth.societyId,
            idempotentRow.paymentGatewayOrderId,
            idempotentRow.id,
            Number(idempotentRow.amountPaid),
          );
          if (resolved) {
            res.status(200).json(resolved);
            return;
          }
          // resolved === null means FAILED at PhonePe → fall through to create new payment
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
      const adjustedDue = payAllQuote
        ? payAllQuote.maintenanceTotal
        : await computeCycleAdjustedDue(auth.societyId, auth.userId, cycle, currentLedger);

      if (adjustedDue <= 0) {
        res.status(400).json({ message: "No amount due for this cycle", code: "NOTHING_DUE" });
        return;
      }

      const existing = await prisma.userCyclePayment.findUnique({
        where: { userId_cycleId: { userId: auth.userId, cycleId } },
      });
      if (existing?.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
        res.status(409).json({ message: "Already paid for this cycle", code: "ALREADY_PAID" });
        return;
      }

      // Prevent orphaned orders: if a PENDING payment already has a gateway
      // transaction, reconcile with PhonePe first. If still PENDING, return
      // for client-side polling. If failed, fall through to create a new one.
      if (
        existing?.paymentStatus === BillingUserPaymentStatus.PENDING &&
        existing.paymentGatewayOrderId
      ) {
        const resolved = await reconcileExistingOrder(
          auth.societyId,
          existing.paymentGatewayOrderId,
          existing.id,
          adjustedDue,
          payAllPending === true,
          payAllQuote?.pendingCount ?? 1,
        );
        if (resolved) {
          res.status(200).json(resolved);
          return;
        }
        // resolved === null means FAILED at PhonePe → fall through to create new payment
      }

      if (!(await isPhonePeConfiguredForSociety(auth.societyId))) {
        res.status(503).json({
          message: "PhonePe payments are not configured",
          code: "PAYMENT_GATEWAY_UNAVAILABLE",
        });
        return;
      }

      const apiBaseUrl = (process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 4000}`).replace(
        /\/$/,
        "",
      );
      if (
        process.env.NODE_ENV === "production" &&
        /localhost|127\.0\.0\.1/i.test(apiBaseUrl)
      ) {
        logger.error(
          { apiBaseUrl },
          "[phonepe] API_BASE_URL is localhost in production — PhonePe cannot deliver callbacks",
        );
        res.status(503).json({
          message:
            "PhonePe callback URL is not configured. Set API_BASE_URL on the server to your public HTTPS URL.",
          code: "PHONEPE_CALLBACK_URL_INVALID",
        });
        return;
      }

      try {
        await prisma.$transaction(async (tx) => {
          await ensureMaintenanceCollectionForBillingCycle(tx, cycleId);
        });
      } catch (linkErr) {
        logger.warn({ err: linkErr, cycleId }, "[phonepe] billing→collection pre-link failed");
      }

      const merchantTransactionId = buildMerchantTransactionId(cycle.cycleKey, auth.userId);
      const callbackUrl = `${apiBaseUrl}/api/v1/payments/phonepe/callback`;
      const redirectUrl = `${apiBaseUrl}/api/v1/payments/phonepe/redirect?txnId=${encodeURIComponent(merchantTransactionId)}`;

      const result = await initiatePhonePePayment(auth.societyId, {
        amount: Math.round(adjustedDue * 100),
        merchantTransactionId,
        merchantUserId: auth.userId,
        callbackUrl,
        redirectUrl,
      });

      if (!result) {
        res.status(502).json({ message: "PhonePe payment initiation failed", code: "GATEWAY_ERROR" });
        return;
      }

      // Atomically create or update the payment row. The transaction ensures
      // a concurrent webhook can't settle the row to SUCCESS between our
      // earlier read and this write.
      const paymentRow = await prisma.$transaction(async (tx) => {
        const current = await tx.userCyclePayment.findUnique({
          where: { userId_cycleId: { userId: auth.userId, cycleId } },
        });
        // Guard: if a webhook just settled this to SUCCESS, don't overwrite
        if (current?.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
          return null;
        }
        return tx.userCyclePayment.upsert({
          where: { userId_cycleId: { userId: auth.userId, cycleId } },
          create: {
            userId: auth.userId,
            cycleId,
            amountPaid: adjustedDue,
            paymentStatus: BillingUserPaymentStatus.PENDING,
            paymentGatewayOrderId: merchantTransactionId,
            idempotencyKey: idempotencyKey ?? null,
          },
          update: {
            amountPaid: adjustedDue,
            paymentStatus: BillingUserPaymentStatus.PENDING,
            paymentGatewayOrderId: merchantTransactionId,
            idempotencyKey: idempotencyKey ?? undefined,
          },
        });
      });

      if (!paymentRow) {
        res.status(409).json({ message: "Already paid for this cycle", code: "ALREADY_PAID" });
        return;
      }

      await prisma.billingPaymentLog.create({
        data: {
          societyId: auth.societyId,
          userId: auth.userId,
          cycleId,
          status: "phonepe_initiate",
          requestPayload: {
            merchantTransactionId,
            payAllPending: payAllPending === true,
            pendingCycleCount: payAllQuote?.pendingCount,
          } as object,
        },
      });

      res.status(201).json({
        redirectUrl: result.redirectUrl,
        merchantTransactionId: result.merchantTransactionId,
        paymentId: paymentRow.id,
        totalDue: adjustedDue,
        payAllPending: payAllPending === true,
        pendingCycleCount: payAllQuote?.pendingCount ?? 1,
      });
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  "/payments/phonepe/status/:txnId",
  requireAuth,
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const auth = req.auth!;
      const { txnId } = req.params;

      const localRow = await prisma.userCyclePayment.findFirst({
        where: {
          paymentGatewayOrderId: txnId,
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
          message: "Payment not found for this transaction",
          code: "PAYMENT_NOT_FOUND",
          status: "UNKNOWN",
          outcome: "unknown",
        });
        return;
      }

      let poll;
      try {
        poll = await reconcilePhonePeFromPoll(auth.societyId, txnId);
      } catch (reconcileErr) {
        logger.error({ err: reconcileErr, txnId }, "[phonepe status] unexpected reconcile error");
        res.status(200).json({
          status: localRow.paymentStatus,
          outcome: "reconcile_failed",
          phonepeState: "UNKNOWN",
          phonepeCode: null,
          phonepeAvailable: false,
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
          txnId,
          localStatus: localRow.paymentStatus,
          status,
          outcome: poll.outcome,
          phonepeState: poll.gateway.rawState,
          phonepeCode: poll.gateway.rawCode,
          reconciled: poll.reconciled,
        },
        "[phonepe status] poll result",
      );

      const ledgerSynced = await isGatewayLedgerSynced(
        {
          id: localRow.id,
          userId: localRow.userId,
          cycleId: localRow.cycleId,
          amountPaid: localRow.amountPaid,
          cycle: { societyId: localRow.cycle.societyId, id: localRow.cycle.id },
        },
        txnId,
      );

      res.json({
        status,
        outcome: poll.outcome,
        phonepeState: poll.gateway.rawState,
        phonepeCode: poll.gateway.rawCode ?? null,
        phonepeAvailable: poll.gateway.gatewayReachable,
        reconciled: poll.reconciled,
        ledgerSynced,
        paymentId: localRow.id,
        detail: poll.gateway.detail ?? null,
      });
    } catch (e) {
      next(e);
    }
  }
);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

router.get("/payments/phonepe/redirect", async (req, res) => {
  const txnId = String(req.query.txnId ?? "").trim();
  if (txnId) {
    try {
      const row = await prisma.userCyclePayment.findFirst({
        where: { paymentGatewayOrderId: txnId },
        include: { cycle: { select: { societyId: true } } },
      });
      if (row) {
        const poll = await reconcilePhonePeFromPoll(row.cycle.societyId, txnId);
        logger.info(
          {
            txnId,
            outcome: poll.outcome,
            reconciled: poll.reconciled,
            phonepeState: poll.gateway.rawState,
            phonepeCode: poll.gateway.rawCode,
          },
          "[phonepe redirect] reconcile on return",
        );
      }
    } catch (e) {
      logger.warn({ err: e, txnId }, "[phonepe redirect] reconcile failed");
    }
  }
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Processing</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;text-align:center}
.card{background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,.1);max-width:400px}
.spinner{width:40px;height:40px;border:4px solid #e0e0e0;border-top-color:#6200ee;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}</style>
</head>
<body>
<div class="card">
<div class="spinner"></div>
<h2>Payment Processing</h2>
<p>Your payment is being verified. You may close this window and return to the app.</p>
<p style="color:#888;font-size:13px">Transaction: ${escapeHtml(String(txnId).slice(0, 36))}</p>
</div>
</body></html>`);
});

export default router;
