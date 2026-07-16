import {
  BillingPaymentSource,
  MaintenanceBillingRole,
  PaymentMode,
  Prisma,
} from "@prisma/client";
import crypto from "node:crypto";
import { residentLikeRoleFilter } from "./residentLike";
import { attemptGatewayRefund, type GatewayRefundResult } from "./gatewayRefund";
import { applyVillaCreditAcrossSnapshots } from "../modules/maintenance-management/credit-walker";
import { syncVillaBillingCyclesFromSnapshots } from "../modules/billing-cycle/billing-collection-link";
import { invalidateMoneySnapshotCache } from "./societyFinance";

type Tx = Prisma.TransactionClient;

export class PaymentReversalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaymentReversalError";
  }
}

export type ReverseMaintenancePaymentResult = {
  originalPaymentId: string;
  offsetPaymentId: string;
  receiptNumber: string;
  gatewayRefund: GatewayRefundResult;
};

/**
 * Reverse a single maintenance payment by creating a negative offset row (L1).
 * Must run inside prisma.$transaction.
 */
export async function reverseMaintenancePayment(
  tx: Tx,
  params: {
    paymentId: string;
    societyId: string;
    reversedByUserId: string;
    reason?: string;
  },
): Promise<ReverseMaintenancePaymentResult> {
  const payment = await tx.maintenancePayment.findFirst({
    where: { id: params.paymentId, societyId: params.societyId },
  });

  if (!payment) {
    throw new PaymentReversalError("PAYMENT_NOT_FOUND", "Payment not found");
  }
  if (payment.reversalOfPaymentId) {
    throw new PaymentReversalError("ALREADY_OFFSET", "Cannot reverse a reversal offset row");
  }
  if (payment.reversedAt) {
    throw new PaymentReversalError("ALREADY_REVERSED", "Payment was already reversed");
  }

  const amountNum = Number(payment.amount);
  if (amountNum <= 0) {
    throw new PaymentReversalError("INVALID_AMOUNT", "Only positive payments can be reversed");
  }

  const gatewayRefund = await attemptGatewayRefund({
    societyId: params.societyId,
    transactionId: payment.transactionId,
    amount: amountNum,
    paymentMode: payment.paymentMode,
  });

  const reversedAt = new Date();
  const offsetReceipt = `REV-${payment.receiptNumber}-${crypto.randomUUID().slice(0, 6)}`;

  await tx.maintenancePayment.update({
    where: { id: payment.id },
    data: {
      reversedAt,
      reversedByUserId: params.reversedByUserId,
      reversalReason: params.reason?.trim() || null,
    },
  });

  const offset = await tx.maintenancePayment.create({
    data: {
      societyId: payment.societyId,
      villaId: payment.villaId,
      maintenanceId: payment.maintenanceId,
      month: payment.month,
      year: payment.year,
      amount: new Prisma.Decimal(-amountNum),
      paymentDate: reversedAt,
      paymentMode: payment.paymentMode,
      transactionId: payment.transactionId
        ? `${payment.transactionId}-rev-${crypto.randomUUID().slice(0, 8)}`
        : undefined,
      receiptNumber: offsetReceipt,
      bankAccountId: payment.bankAccountId,
      remarks: params.reason?.trim()
        ? `Reversal of ${payment.receiptNumber}: ${params.reason.trim()}`
        : `Reversal of ${payment.receiptNumber}`,
      reversalOfPaymentId: payment.id,
      maintenanceCollectionCycleId: payment.maintenanceCollectionCycleId,
      villaMaintenanceSnapshotId: payment.villaMaintenanceSnapshotId,
      financialYearId: payment.financialYearId,
    },
  });

  if (payment.maintenanceCollectionCycleId && payment.financialYearId) {
    await applyVillaCreditAcrossSnapshots(tx, {
      societyId: params.societyId,
      villaId: payment.villaId,
      financialYearId: payment.financialYearId,
    });

    await syncVillaBillingCyclesFromSnapshots(tx, {
      societyId: params.societyId,
      villaId: payment.villaId,
      source:
        payment.paymentMode === PaymentMode.ONLINE ||
        payment.paymentMode === PaymentMode.PHONEPE
          ? BillingPaymentSource.GATEWAY
          : BillingPaymentSource.CASH_MANUAL,
    });

    const snap = await tx.villaMaintenanceSnapshot.findUnique({
      where: {
        cycleId_villaId: {
          cycleId: payment.maintenanceCollectionCycleId,
          villaId: payment.villaId,
        },
      },
      select: { paidAmount: true, status: true },
    });

    if (snap) {
      await tx.maintenance.updateMany({
        where: {
          societyId: params.societyId,
          villaId: payment.villaId,
          month: payment.month,
          year: payment.year,
        },
        data: {
          status:
            snap.status === "PAID"
              ? "PAID"
              : snap.status === "OVERDUE"
                ? "OVERDUE"
                : "PENDING",
        },
      });

      const cycle = await tx.maintenanceCollectionCycle.findUnique({
        where: { id: payment.maintenanceCollectionCycleId },
        select: { periodKey: true, financialYearId: true },
      });
      if (cycle) {
        const billingCycle = await tx.billingCycle.findFirst({
          where: {
            societyId: params.societyId,
            financialYearId: cycle.financialYearId,
            cycleKey: cycle.periodKey,
          },
          select: { id: true },
        });
        if (billingCycle && snap.status !== "PAID" && snap.status !== "WAIVED") {
          const primaryResidents = await tx.user.findMany({
            where: {
              societyId: params.societyId,
              villaId: payment.villaId,
              ...residentLikeRoleFilter,
              isActive: true,
              maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
            },
            select: { id: true },
          });
          for (const u of primaryResidents) {
            await tx.userCyclePayment.updateMany({
              where: { userId: u.id, cycleId: billingCycle.id },
              data: {
                paymentGatewayOrderId: null,
                paymentGatewayPaymentId: null,
                idempotencyKey: null,
              },
            });
          }
        }
      }
    }
  }

  await tx.adminAuditLog.create({
    data: {
      adminId: params.reversedByUserId,
      societyId: params.societyId,
      action: "PAYMENT_REVERSED_SINGLE",
      entityType: "MaintenancePayment",
      entityId: payment.id,
      metadata: {
        offsetPaymentId: offset.id,
        villaId: payment.villaId,
        amount: amountNum.toString(),
        receiptNumber: payment.receiptNumber,
        offsetReceiptNumber: offsetReceipt,
        reason: params.reason || undefined,
        gatewayRefund,
        timestamp: reversedAt.toISOString(),
      },
    },
  });

  invalidateMoneySnapshotCache(params.societyId);

  return {
    originalPaymentId: payment.id,
    offsetPaymentId: offset.id,
    receiptNumber: offsetReceipt,
    gatewayRefund,
  };
}
