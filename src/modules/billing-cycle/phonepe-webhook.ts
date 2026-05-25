import type { Request, Response } from "express";
import { BillingPaymentSource, BillingUserPaymentStatus, PaymentMode } from "@prisma/client";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { verifyPhonePeCallback } from "../../services/phonepe-billing";
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
  const state = decoded.data?.state ?? decoded.code ?? "UNKNOWN";
  const isSuccess = decoded.success === true && state === "COMPLETED";
  const isFailure = state === "FAILED" || state === "PAYMENT_ERROR";

  if (!merchantTransactionId) {
    res.status(400).json({ message: "Missing merchantTransactionId in response" });
    return;
  }

  try {
    // Look up the payment row by merchantTransactionId
    const row = await prisma.userCyclePayment.findFirst({
      where: { paymentGatewayOrderId: merchantTransactionId },
      include: {
        cycle: { select: { societyId: true, id: true } },
      },
    });

    if (!row) {
      // Return 200 to prevent PhonePe from retrying for orders we don't recognize
      res.status(200).json({ ok: true, skipped: true, reason: "unknown_order" });
      return;
    }

    // Idempotency: skip if already SUCCESS
    if (row.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
      res.status(200).json({ ok: true, idempotent: true });
      return;
    }

    // Verify checksum using the society's salt key
    const verified = await verifyPhonePeCallback(row.cycle.societyId, xVerifyStr, responseBase64);
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

    const paidAt = isSuccess ? new Date() : null;
    /** Maintenance principal stored at initiate — not gross PhonePe amount. */
    const maintenanceAmountNum = Number(row.amountPaid);
    const payAllPending = await isPayAllGatewayPayment(row, "phonepe_initiate");

    await prisma.$transaction(async (tx) => {
      await tx.userCyclePayment.update({
        where: { id: row.id },
        data: {
          paymentStatus: isFailure ? BillingUserPaymentStatus.FAILED : BillingUserPaymentStatus.SUCCESS,
          paymentGatewayPaymentId: phonepeTransactionId ?? merchantTransactionId,
          paidAt,
          source: BillingPaymentSource.GATEWAY,
        },
      });

      if (row.userId) {
        await tx.billingPaymentLog.create({
          data: {
            societyId: row.cycle.societyId,
            userId: row.userId,
            cycleId: row.cycle.id,
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

      if (isSuccess) {
        await applyGatewayPaymentSuccess(tx, {
          row,
          maintenanceAmount: maintenanceAmountNum,
          paidAt: paidAt!,
          paymentMode: PaymentMode.PHONEPE,
          remarks: payAllPending ? "PhonePe pay-all settlement" : "PhonePe online payment sync",
          payAllPending,
          gatewayTransactionId: phonepeTransactionId ?? merchantTransactionId,
        });
      }
    });

    if (isSuccess && row.userId) {
      try {
        await notifyUser(row.userId, {
          title: "Payment received",
          body: "Your maintenance payment was recorded successfully.",
          data: { cycleId: row.cycle.id, type: "billing_payment_success" },
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
