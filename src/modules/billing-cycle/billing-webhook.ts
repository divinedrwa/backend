import type { Request, Response } from "express";
import { BillingPaymentSource, BillingUserPaymentStatus, PaymentMode, Prisma } from "@prisma/client";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { verifyRazorpayWebhookSignature, verifyRazorpayWebhookSignatureWithSecret } from "./services/razorpay-webhook-verify";
import { getWebhookSecretForSociety } from "./services/razorpay-billing";
import { notifyUser } from "../../services/notification.service";
import { applyGatewayPaymentSuccess, isPayAllGatewayPayment } from "./gateway-payment-settle";
import {
  isRazorpayWebhookFailEvent,
  isRazorpayWebhookSettleEvent,
} from "../../services/razorpay-status";

/**
 * Razorpay webhook — raw Buffer body. Mounted with express.raw before json().
 */
export async function billingPaymentWebhookHandler(req: Request, res: Response): Promise<void> {
  const stripeSig = req.headers["stripe-signature"];
  if (typeof stripeSig === "string") {
    res.status(501).json({ message: "Stripe webhook adapter not enabled" });
    return;
  }

  const raw = req.body as Buffer;
  const sigHeader = req.headers["x-razorpay-signature"];
  const headerStr = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  const sigStr = typeof headerStr === "string" ? headerStr : undefined;

  // Try global webhook secret first
  const globalVerified = verifyRazorpayWebhookSignature(raw, sigStr);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(400).json({ message: "Invalid JSON" });
    return;
  }

  // If global verification failed, try per-society secret
  if (!globalVerified) {
    // Extract societyId from order notes to look up per-society secret
    const payloadRoot = parsed.payload as Record<string, unknown> | undefined;
    const payContainer = payloadRoot?.payment as Record<string, unknown> | undefined;
    const entity = ((payContainer?.entity as Record<string, unknown>) || payContainer || {}) as Record<string, unknown>;
    const notes = entity.notes as Record<string, string> | undefined;
    const societyId = notes?.societyId;

    let perSocietyVerified = false;
    if (societyId && sigStr) {
      const secret = await getWebhookSecretForSociety(societyId);
      if (secret) {
        perSocietyVerified = verifyRazorpayWebhookSignatureWithSecret(raw, sigStr, secret);
      }
    }

    if (!perSocietyVerified) {
      res.status(400).json({ message: "Invalid signature" });
      return;
    }
  }

  const eventName = typeof parsed.event === "string" ? parsed.event : "";
  const payloadRoot = parsed.payload as Record<string, unknown> | undefined;
  const payContainer = payloadRoot?.payment as Record<string, unknown> | undefined;
  const paymentEntity =
    ((payContainer?.entity as Record<string, unknown>) || payContainer || {}) as Record<string, unknown>;

  const paymentId = typeof paymentEntity.id === "string" ? paymentEntity.id : undefined;
  const orderId = typeof paymentEntity.order_id === "string" ? paymentEntity.order_id : undefined;
  const amountPaise = Number(paymentEntity.amount ?? 0);

  if (!eventName.startsWith("payment.") && !eventName.startsWith("order.")) {
    res.status(200).json({ received: true, ignored: eventName });
    return;
  }

  const isSuccess = isRazorpayWebhookSettleEvent(eventName);
  const isFailure = isRazorpayWebhookFailEvent(eventName);

  if (!isSuccess && !isFailure) {
    res.status(200).json({ received: true, ignored: eventName });
    return;
  }

  if (!paymentId || !orderId) {
    res.status(400).json({ message: "Missing payment or order id" });
    return;
  }

  try {
    // Quick pre-check outside tx — fast-path for replayed webhooks.
    // NOT relied on for correctness; the real guard is inside the transaction.
    const dup = await prisma.userCyclePayment.findFirst({
      where: { paymentGatewayPaymentId: paymentId, paymentStatus: BillingUserPaymentStatus.SUCCESS },
    });
    if (dup) {
      res.status(200).json({ ok: true, idempotent: true });
      return;
    }

    const notes = paymentEntity.notes as Record<string, string> | undefined;

    // All state reads + writes inside a single transaction with row-level lock
    const result = await prisma.$transaction(async (tx) => {
      // Lock the row with FOR UPDATE to prevent concurrent webhooks from
      // both reading PENDING and double-settling.
      const [lockedRow] = await tx.$queryRawUnsafe<
        { id: string; userId: string | null; cycleId: string; amountPaid: string; paymentStatus: string }[]
      >(
        `SELECT id, "userId", "cycleId", "amountPaid"::text, "paymentStatus"
         FROM "UserCyclePayment"
         WHERE "paymentGatewayOrderId" = $1
         FOR UPDATE`,
        orderId,
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

      const paidAt = isFailure ? null : new Date();
      const maintenanceAmountNum = Number(lockedRow.amountPaid);
      const amountChargedRupees = amountPaise ? amountPaise / 100 : null;
      const payAllPending =
        notes?.payAllPending === "true" ||
        (await isPayAllGatewayPayment(row, "create_order"));

      await tx.userCyclePayment.update({
        where: { id: row.id },
        data: {
          paymentStatus: isFailure ? BillingUserPaymentStatus.FAILED : BillingUserPaymentStatus.SUCCESS,
          paymentGatewayPaymentId: paymentId,
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
            status: eventName,
            responsePayload: {
              paymentId,
              orderId,
              amountPaise,
              amountChargedRupees,
              maintenanceAmount: maintenanceAmountNum,
            } as object,
          },
        });
      }

      if (!isFailure) {
        await applyGatewayPaymentSuccess(tx, {
          row,
          maintenanceAmount: maintenanceAmountNum,
          paidAt: paidAt!,
          paymentMode: PaymentMode.ONLINE,
          remarks: payAllPending
            ? "Razorpay pay-all settlement"
            : "Razorpay online payment sync",
          payAllPending,
          gatewayTransactionId: paymentId,
        });
      }

      logger.info(
        { orderId, paymentId, amount: maintenanceAmountNum, payAllPending, event: eventName },
        "[billing webhook] payment settled",
      );

      return { action: "settled" as const, userId: row.userId, cycleId: cycle.id, isFailure };
    });

    if (result.action === "skip") {
      res.status(200).json({ ok: true, skipped: true, reason: result.reason });
      return;
    }
    if (result.action === "idempotent") {
      res.status(200).json({ ok: true, idempotent: true });
      return;
    }

    if (!result.isFailure && result.userId) {
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
    logger.error({ err: e }, "[billing webhook] processing failed");
    res.status(500).json({ message: "Processing failed" });
  }
}
