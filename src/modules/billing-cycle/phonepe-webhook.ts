import type { Request, Response } from "express";
import { BillingPaymentSource, BillingUserPaymentStatus, PaymentMode, Prisma } from "@prisma/client";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import {
  classifyPhonePeGatewayPayload,
  isPhonePePaymentFailed,
  isPhonePePaymentSuccessful,
  verifyPhonePeCallback,
  verifyPhonePeV2Webhook,
} from "../../services/phonepe-billing";
import { notifyUser } from "../../services/notification.service";
import {
  applyGatewayPaymentSuccess,
  isPayAllGatewayPayment,
  resolveGatewayMaintenanceAmount,
} from "./gateway-payment-settle";

// ---------------------------------------------------------------------------
// V2 webhook handler
// ---------------------------------------------------------------------------

/**
 * PhonePe V2 webhook handler.
 * V2 format: { event: "checkout.order.completed"|"checkout.order.failed",
 *              payload: { orderId, merchantOrderId, state, amount, timestamp } }
 * Auth: Authorization header = SHA256(username:password)
 */
async function handlePhonePeV2Webhook(req: Request, res: Response): Promise<boolean> {
  const body = req.body as Record<string, unknown> | undefined;
  const event = body?.event;
  if (typeof event !== "string" || !event.startsWith("checkout.")) {
    return false; // Not a V2 webhook — let V1 handler try
  }

  const authHeader = req.headers.authorization;
  if (!verifyPhonePeV2Webhook(typeof authHeader === "string" ? authHeader : undefined)) {
    logger.warn("[phonepe-v2 webhook] authorization verification failed");
    res.status(400).json({ message: "Invalid authorization" });
    return true;
  }

  const payload = body?.payload as Record<string, unknown> | undefined;
  const merchantOrderId = typeof payload?.merchantOrderId === "string" ? payload.merchantOrderId : undefined;
  const orderId = typeof payload?.orderId === "string" ? payload.orderId : undefined;
  const state = typeof payload?.state === "string" ? payload.state.toUpperCase() : "";
  const amountPaise = typeof payload?.amount === "number" ? payload.amount : 0;

  const isSuccess = event === "checkout.order.completed" || state === "COMPLETED";
  const isFailure = event === "checkout.order.failed" || state === "FAILED";

  if (!merchantOrderId) {
    res.status(400).json({ message: "Missing merchantOrderId in V2 webhook payload" });
    return true;
  }

  if (!isSuccess && !isFailure) {
    res.status(200).json({ ok: true, ignored: event });
    return true;
  }

  logger.info(
    { event, merchantOrderId, orderId, state, amountPaise },
    "[phonepe-v2 webhook] received",
  );

  try {
    await settlePhonePePayment({
      merchantTransactionId: merchantOrderId,
      phonepeTransactionId: orderId ?? merchantOrderId,
      amountPaise,
      state,
      isSuccess,
      isFailure,
      eventLabel: event,
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, "[phonepe-v2 webhook] processing failed");
    res.status(500).json({ message: "Processing failed" });
  }
  return true;
}

// ---------------------------------------------------------------------------
// V1 webhook handler
// ---------------------------------------------------------------------------

async function handlePhonePeV1Webhook(req: Request, res: Response): Promise<void> {
  const xVerify = req.headers["x-verify"];
  const xVerifyStr = typeof xVerify === "string" ? xVerify : Array.isArray(xVerify) ? xVerify[0] : undefined;

  const body = req.body as { response?: string } | undefined;
  const responseBase64 = body?.response;

  if (!xVerifyStr || !responseBase64) {
    res.status(400).json({ message: "Missing X-VERIFY header or response body" });
    return;
  }

  // Decode the base64 response to extract transaction details
  let decoded: {
    success?: boolean;
    code?: string;
    data?: {
      merchantTransactionId?: string;
      transactionId?: string;
      amount?: number;
      state?: string;
    };
  };
  try {
    decoded = JSON.parse(Buffer.from(responseBase64, "base64").toString("utf8"));
  } catch {
    res.status(400).json({ message: "Invalid base64 response" });
    return;
  }

  const merchantTransactionId = decoded.data?.merchantTransactionId;
  const phonepeTransactionId = decoded.data?.transactionId;
  const amountPaise = decoded.data?.amount ?? 0;
  const classified = classifyPhonePeGatewayPayload({
    success: decoded.success,
    code: decoded.code,
    data: decoded.data,
  });
  const state = classified.rawState;
  const isSuccess =
    classified.outcome === "completed" ||
    isPhonePePaymentSuccessful(decoded.success === true, state, classified.rawCode);
  const isFailure =
    classified.outcome === "failed" || isPhonePePaymentFailed(state, classified.rawCode);

  if (!merchantTransactionId) {
    res.status(400).json({ message: "Missing merchantTransactionId in response" });
    return;
  }

  // Look up payment row to get societyId for signature verification
  const preRow = await prisma.userCyclePayment.findFirst({
    where: { paymentGatewayOrderId: merchantTransactionId },
    include: { cycle: { select: { societyId: true } } },
  });

  if (!preRow) {
    logger.warn(
      { merchantTransactionId, phonepeTransactionId, state },
      "[phonepe-v1 webhook] no payment row found",
    );
    res.status(200).json({ ok: true, skipped: true, reason: "unknown_order" });
    return;
  }

  if (preRow.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
    res.status(200).json({ ok: true, idempotent: true });
    return;
  }

  const verified = await verifyPhonePeCallback(preRow.cycle.societyId, xVerifyStr, responseBase64);
  if (!verified) {
    logger.warn({ merchantTransactionId }, "[phonepe-v1 webhook] checksum verification failed");
    res.status(400).json({ message: "Invalid signature" });
    return;
  }

  if (!isSuccess && !isFailure) {
    res.status(200).json({ ok: true, state });
    return;
  }

  try {
    await settlePhonePePayment({
      merchantTransactionId,
      phonepeTransactionId: phonepeTransactionId ?? merchantTransactionId,
      amountPaise,
      state,
      isSuccess,
      isFailure,
      eventLabel: isSuccess ? "phonepe.payment.success" : "phonepe.payment.failed",
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, "[phonepe-v1 webhook] processing failed");
    res.status(500).json({ message: "Processing failed" });
  }
}

// ---------------------------------------------------------------------------
// Shared settlement logic
// ---------------------------------------------------------------------------

async function settlePhonePePayment(params: {
  merchantTransactionId: string;
  phonepeTransactionId: string;
  amountPaise: number;
  state: string;
  isSuccess: boolean;
  isFailure: boolean;
  eventLabel: string;
}): Promise<void> {
  const {
    merchantTransactionId,
    phonepeTransactionId,
    amountPaise,
    state,
    isSuccess,
    isFailure,
    eventLabel,
  } = params;

  // Quick pre-check for idempotency
  const dup = await prisma.userCyclePayment.findFirst({
    where: { paymentGatewayOrderId: merchantTransactionId, paymentStatus: BillingUserPaymentStatus.SUCCESS },
  });
  if (dup) return;

  const result = await prisma.$transaction(async (tx) => {
    const [lockedRow] = await tx.$queryRawUnsafe<
      { id: string; userId: string | null; cycleId: string; amountPaid: string; paymentStatus: string }[]
    >(
      `SELECT id, "userId", "cycleId", "amountPaid"::text, "paymentStatus"
       FROM "user_payments"
       WHERE "paymentGatewayOrderId" = $1
       FOR UPDATE`,
      merchantTransactionId,
    );

    if (!lockedRow) return { action: "skip" as const, reason: "unknown_order" };

    if (lockedRow.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
      return { action: "idempotent" as const };
    }

    const cycle = await tx.billingCycle.findUnique({
      where: { id: lockedRow.cycleId },
      select: { societyId: true, id: true },
    });
    if (!cycle) return { action: "skip" as const, reason: "cycle_not_found" };

    const row = {
      id: lockedRow.id,
      userId: lockedRow.userId,
      cycleId: lockedRow.cycleId,
      amountPaid: new Prisma.Decimal(lockedRow.amountPaid),
      cycle: { societyId: cycle.societyId, id: cycle.id },
    };

    const paidAt = isSuccess ? new Date() : null;
    // Mirror the Razorpay webhook: never settle/validate against a stale 0 amount.
    // A zeroed amountPaid would make expectedPaise 0 (bypassing the underpayment
    // guard) and credit the resident's ledger 0 while marking the row SUCCESS.
    let maintenanceAmountNum = Number(lockedRow.amountPaid);
    if (maintenanceAmountNum <= 0.005) {
      maintenanceAmountNum = await resolveGatewayMaintenanceAmount(row, "phonepe_initiate");
    }
    const payAllPending = await isPayAllGatewayPayment(row, "phonepe_initiate");
    const gatewayTxnId = phonepeTransactionId;

    // Amount validation
    if (isSuccess && amountPaise > 0) {
      const expectedPaise = Math.round(maintenanceAmountNum * 100);
      if (amountPaise < expectedPaise - 1) {
        logger.error(
          { merchantTransactionId, expectedPaise, actualPaise: amountPaise },
          "[phonepe webhook] AMOUNT MISMATCH",
        );
        return { action: "skip" as const, reason: "amount_mismatch" };
      }
    }

    if (isSuccess) {
      await applyGatewayPaymentSuccess(tx, {
        row,
        maintenanceAmount: maintenanceAmountNum,
        paidAt: paidAt!,
        paymentMode: PaymentMode.PHONEPE,
        remarks: payAllPending ? "PhonePe pay-all settlement" : "PhonePe online payment sync",
        payAllPending,
        gatewayTransactionId: gatewayTxnId,
      });
    }

    await tx.userCyclePayment.update({
      where: { id: row.id },
      data: {
        paymentStatus: isFailure ? BillingUserPaymentStatus.FAILED : BillingUserPaymentStatus.SUCCESS,
        paymentGatewayPaymentId: gatewayTxnId,
        ...(isFailure ? {} : { amountPaid: maintenanceAmountNum }),
        paidAt,
        source: BillingPaymentSource.GATEWAY,
      },
    });

    if (row.userId) {
      await tx.billingPaymentLog.create({
        data: {
          societyId: cycle.societyId,
          userId: row.userId,
          cycleId: cycle.id,
          status: eventLabel,
          responsePayload: {
            merchantTransactionId,
            phonepeTransactionId,
            amountPaise,
            state,
          } as object,
        },
      });
    }

    logger.info(
      { merchantTransactionId, phonepeTransactionId, amount: maintenanceAmountNum, payAllPending, state },
      "[phonepe webhook] payment settled",
    );

    return { action: "settled" as const, userId: row.userId, cycleId: cycle.id, isSuccess };
  }, { timeout: 30_000 });

  if (result.action === "settled" && result.userId) {
    try {
      if (result.isSuccess) {
        await notifyUser(result.userId, {
          title: "Payment received",
          body: "Your maintenance payment was recorded successfully.",
          data: { cycleId: result.cycleId, type: "billing_payment_success" },
        });
      } else {
        await notifyUser(result.userId, {
          title: "Payment failed",
          body: "Your maintenance payment could not be processed. Please try again.",
          data: { cycleId: result.cycleId, type: "billing_payment_failed" },
        });
      }
    } catch {
      /* optional push */
    }
  }
}

// ---------------------------------------------------------------------------
// Unified handler — tries V2 first, falls back to V1
// ---------------------------------------------------------------------------

/**
 * PhonePe server-to-server callback handler.
 * Detects V2 (event-based) vs V1 (X-VERIFY + base64) format automatically.
 */
export async function phonePeCallbackHandler(req: Request, res: Response): Promise<void> {
  // Try V2 format first (checks for "event" field starting with "checkout.")
  const handledByV2 = await handlePhonePeV2Webhook(req, res);
  if (handledByV2) return;

  // Fall back to V1 format
  await handlePhonePeV1Webhook(req, res);
}
