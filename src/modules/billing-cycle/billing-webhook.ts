import crypto from "crypto";
import type { Request, Response } from "express";
import { BillingPaymentSource, BillingUserPaymentStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { verifyRazorpayWebhookSignature } from "./services/razorpay-webhook-verify";
import { notifyUser } from "../../services/notification.service";
import { applyVillaCreditAcrossSnapshots } from "../maintenance-management/credit-walker";
import { refreshSnapshotStatus } from "../maintenance-management/snapshot-helpers";

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
    const amountPaidNum = amountPaise ? amountPaise / 100 : Number(row.amountPaid);

    await prisma.$transaction(async (tx) => {
      await tx.userCyclePayment.update({
        where: { id: row.id },
        data: {
          paymentStatus: isFailure ? BillingUserPaymentStatus.FAILED : BillingUserPaymentStatus.SUCCESS,
          paymentGatewayPaymentId: paymentId,
          amountPaid: amountPaidNum,
          paidAt,
          source: BillingPaymentSource.GATEWAY,
        },
      });

      await tx.billingPaymentLog.create({
        data: {
          societyId: row.cycle.societyId,
          userId: row.userId,
          cycleId: row.cycle.id,
          status: eventName,
          responsePayload: { paymentId, orderId, amountPaise } as object,
        },
      });

      // ── Sync maintenance ledger for successful payments ──
      if (!isFailure) {
        const billingCycle = await tx.billingCycle.findUnique({
          where: { id: row.cycleId },
          select: { cycleKey: true, financialYearId: true, societyId: true },
        });

        const user = await tx.user.findUnique({
          where: { id: row.userId },
          select: { villaId: true },
        });

        if (billingCycle?.financialYearId && user?.villaId) {
          const maintenanceCycle = await tx.maintenanceCollectionCycle.findFirst({
            where: {
              societyId: billingCycle.societyId,
              financialYearId: billingCycle.financialYearId,
              periodKey: billingCycle.cycleKey,
            },
          });

          if (maintenanceCycle) {
            // Lock the snapshot row to prevent concurrent calls from
            // reading the same paidAmount and double-counting.
            const [snapshot] = await tx.$queryRawUnsafe<
              { id: string; expectedAmount: string; paidAmount: string }[]
            >(
              `SELECT id, "expectedAmount"::text, "paidAmount"::text FROM "VillaMaintenanceSnapshot" WHERE "cycleId" = $1 AND "villaId" = $2 FOR UPDATE`,
              maintenanceCycle.id,
              user.villaId,
            );

            if (snapshot) {
              const expected = Number(snapshot.expectedAmount);
              const paidSoFar = Number(snapshot.paidAmount);
              const appliedToCycle = Math.max(0, Math.min(amountPaidNum, expected - paidSoFar));
              const newPaid = paidSoFar + appliedToCycle;
              const snapStatus = refreshSnapshotStatus(expected, newPaid, maintenanceCycle.dueDate);

              // Upsert the legacy Maintenance row so financial-dashboard stays in sync.
              const maintenanceRow = await tx.maintenance.upsert({
                where: {
                  villaId_month_year: {
                    villaId: user.villaId,
                    month: maintenanceCycle.periodMonth,
                    year: maintenanceCycle.periodYear,
                  },
                },
                create: {
                  societyId: billingCycle.societyId,
                  villaId: user.villaId,
                  month: maintenanceCycle.periodMonth,
                  year: maintenanceCycle.periodYear,
                  amount: snapshot.expectedAmount,
                  dueDate: maintenanceCycle.dueDate,
                  status:
                    snapStatus === "PAID"
                      ? "PAID"
                      : snapStatus === "OVERDUE"
                        ? "OVERDUE"
                        : "PENDING",
                },
                update: {
                  amount: snapshot.expectedAmount,
                  dueDate: maintenanceCycle.dueDate,
                  status:
                    snapStatus === "PAID"
                      ? "PAID"
                      : snapStatus === "OVERDUE"
                        ? "OVERDUE"
                        : "PENDING",
                },
              });

              // Record the full amount as a MaintenancePayment row — the cash
              // ledger that financial-dashboard reads for allTimeCollected /
              // currentFundBalance.
              if (amountPaidNum > 0.005) {
                await tx.maintenancePayment.create({
                  data: {
                    societyId: billingCycle.societyId,
                    villaId: user.villaId,
                    maintenanceId: maintenanceRow.id,
                    month: maintenanceCycle.periodMonth,
                    year: maintenanceCycle.periodYear,
                    amount: new Prisma.Decimal(amountPaidNum),
                    paymentDate: paidAt!,
                    paymentMode: "ONLINE",
                    receiptNumber: `RCP-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
                    remarks: "Razorpay online payment sync",
                    maintenanceCollectionCycleId: maintenanceCycle.id,
                    villaMaintenanceSnapshotId: snapshot.id,
                  },
                });
              }

              await tx.villaMaintenanceSnapshot.update({
                where: { id: snapshot.id },
                data: {
                  paidAmount: new Prisma.Decimal(newPaid),
                  status: snapStatus,
                },
              });
            }

            // Reconcile snapshots up to this cycle so advance credit is
            // accounted for (mirrors mark-cash handler logic).
            await applyVillaCreditAcrossSnapshots(tx, {
              societyId: billingCycle.societyId,
              villaId: user.villaId,
              financialYearId: billingCycle.financialYearId,
              throughCycleId: maintenanceCycle.id,
            });
          }
        }
      }
    });

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
