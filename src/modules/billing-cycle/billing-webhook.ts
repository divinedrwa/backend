import type { Request, Response } from "express";
import { BillingPaymentSource, BillingUserPaymentStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { verifyRazorpayWebhookSignature } from "./services/razorpay-webhook-verify";
import { notifyUser } from "../../services/notification.service";

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

  if (!verifyRazorpayWebhookSignature(raw, typeof headerStr === "string" ? headerStr : undefined)) {
    res.status(400).json({ message: "Invalid signature" });
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(400).json({ message: "Invalid JSON" });
    return;
  }

  const eventName = typeof parsed.event === "string" ? parsed.event : "";
  const payloadRoot = parsed.payload as Record<string, unknown> | undefined;
  const payContainer = payloadRoot?.payment as Record<string, unknown> | undefined;
  const paymentEntity =
    ((payContainer?.entity as Record<string, unknown>) || payContainer || {}) as Record<string, unknown>;

  const paymentId = typeof paymentEntity.id === "string" ? paymentEntity.id : undefined;
  const orderId = typeof paymentEntity.order_id === "string" ? paymentEntity.order_id : undefined;
  const amountPaise = Number(paymentEntity.amount ?? 0);

  if (!eventName.startsWith("payment.")) {
    res.status(200).json({ received: true, ignored: eventName });
    return;
  }

  if (!paymentId || !orderId) {
    res.status(400).json({ message: "Missing payment or order id" });
    return;
  }

  try {
    const dup = await prisma.userCyclePayment.findFirst({
      where: { paymentGatewayPaymentId: paymentId, paymentStatus: BillingUserPaymentStatus.SUCCESS },
    });
    if (dup) {
      res.status(200).json({ ok: true, idempotent: true });
      return;
    }

    const row = await prisma.userCyclePayment.findFirst({
      where: { paymentGatewayOrderId: orderId },
      include: {
        cycle: { select: { societyId: true, id: true } },
      },
    });

    if (!row) {
      res.status(404).json({ message: "Unknown order" });
      return;
    }

    if (row.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
      res.status(200).json({ ok: true, idempotent: true });
      return;
    }

    const isFailure = eventName === "payment.failed";
    const paidAt = isFailure ? null : new Date();

    await prisma.$transaction([
      prisma.userCyclePayment.update({
        where: { id: row.id },
        data: {
          paymentStatus: isFailure ? BillingUserPaymentStatus.FAILED : BillingUserPaymentStatus.SUCCESS,
          paymentGatewayPaymentId: paymentId,
          amountPaid: amountPaise ? amountPaise / 100 : Number(row.amountPaid),
          paidAt,
          source: BillingPaymentSource.GATEWAY,
        },
      }),
      prisma.billingPaymentLog.create({
        data: {
          societyId: row.cycle.societyId,
          userId: row.userId,
          cycleId: row.cycle.id,
          status: eventName,
          responsePayload: { paymentId, orderId, amountPaise } as object,
        },
      }),
    ]);

    if (!isFailure) {
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
    console.error("[billing webhook]", e);
    res.status(500).json({ message: "Processing failed" });
  }
}
