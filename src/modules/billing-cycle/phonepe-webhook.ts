import type { Request, Response } from "express";
import { BillingPaymentSource, BillingUserPaymentStatus, PaymentMode, Prisma } from "@prisma/client";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import {
  classifyPhonePeGatewayPayload,
  isPhonePePaymentFailed,
  isPhonePePaymentSuccessful,
  verifyPhonePeCallback,
} from "../../services/phonepe-billing";
import { notifyUser } from "../../services/notification.service";
import { applyGatewayPaymentSuccess, isPayAllGatewayPayment } from "./gateway-payment-settle";

/**
 * PhonePe server-to-server callback handler.
 * Mounted after express.json() (PhonePe sends JSON, not raw body).
 */
export async function phonePeCallbackHandler(req: Request, res: Response): Promise<void> {
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

  try {
    // Quick pre-check: find the row and verify checksum before entering the tx.
    // The row lookup here is a fast-path; the real idempotency guard is inside the tx.
    const preRow = await prisma.userCyclePayment.findFirst({
      where: { paymentGatewayOrderId: merchantTransactionId },
      include: { cycle: { select: { societyId: true, id: true } } },
    });

    if (!preRow) {
      res.status(200).json({ ok: true, skipped: true, reason: "unknown_order" });
      return;
    }

    // Idempotency fast-path (non-authoritative — real check is inside tx)
    if (preRow.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
      res.status(200).json({ ok: true, idempotent: true });
      return;
    }

    // Verify checksum using the society's salt key
    const verified = await verifyPhonePeCallback(preRow.cycle.societyId, xVerifyStr, responseBase64);
    if (!verified) {
      logger.warn({ merchantTransactionId }, "[phonepe webhook] checksum verification failed");
      res.status(400).json({ message: "Invalid signature" });
      return;
    }

    if (!isSuccess && !isFailure) {
      // Intermediate state (PENDING etc.) — acknowledge but don't update
      res.status(200).json({ ok: true, state });
      return;
    }

    // All state reads + writes inside a single transaction with row-level lock
    const result = await prisma.$transaction(async (tx) => {
      // Lock the row with FOR UPDATE to prevent concurrent callbacks from
      // both reading PENDING and double-settling.
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

      // Idempotency: already settled — return without double-processing
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
      const maintenanceAmountNum = Number(lockedRow.amountPaid);
      const payAllPending = await isPayAllGatewayPayment(row, "phonepe_initiate");
      const gatewayTxnId = phonepeTransactionId ?? merchantTransactionId;

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
            status: isSuccess ? "phonepe.payment.success" : "phonepe.payment.failed",
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
    });

    if (result.action === "skip") {
      res.status(200).json({ ok: true, skipped: true, reason: result.reason });
      return;
    }
    if (result.action === "idempotent") {
      res.status(200).json({ ok: true, idempotent: true });
      return;
    }

    if (result.isSuccess && result.userId) {
      try {
        await notifyUser(result.userId, {
          title: "Payment received",
          body: "Your maintenance payment was recorded successfully.",
          data: { cycleId: result.cycleId, type: "billing_payment_success" },
        });
      } catch {
        /* optional push */
      }
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, "[phonepe webhook] processing failed");
    res.status(500).json({ message: "Processing failed" });
  }
}
