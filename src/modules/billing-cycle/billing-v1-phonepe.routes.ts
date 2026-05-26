import { Router } from "express";
import { z } from "zod";
import {
  BillingCycleStatus,
  BillingUserPaymentStatus,
  UserRole,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { deriveCycleStatusUtc } from "./domain/cycleStatus";
import { computeUserBillingLedger } from "./services/cycle-service";
import {
  initiatePhonePePayment,
  isPhonePeConfiguredForSociety,
} from "../../services/phonepe-billing";
import { computeCycleAdjustedDue, computePayAllQuote } from "./services/gateway-pay-all";
import { reconcilePhonePeFromPoll } from "./gateway-payment-settle";

function buildMerchantTransactionId(cycleKey: string, userId: string): string {
  const safeKey = cycleKey.replace(/[^a-zA-Z0-9]/g, "");
  const safeUser = userId.replace(/[^a-zA-Z0-9]/g, "").slice(-10);
  const suffix = Date.now().toString(36);
  return `pp${safeKey}${safeUser}${suffix}`.slice(0, 35);
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

      const paymentRow = await prisma.userCyclePayment.upsert({
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
          ...(auth.role !== "ADMIN" ? { userId: auth.userId } : {}),
        },
        select: { id: true, paymentStatus: true },
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

      const poll = await reconcilePhonePeFromPoll(auth.societyId, txnId);
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

      res.json({
        status,
        outcome: poll.outcome,
        phonepeState: poll.gateway.rawState,
        phonepeCode: poll.gateway.rawCode ?? null,
        phonepeAvailable: poll.gateway.gatewayReachable,
        reconciled: poll.reconciled,
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

router.get("/payments/phonepe/redirect", (req, res) => {
  const txnId = req.query.txnId ?? "";
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
