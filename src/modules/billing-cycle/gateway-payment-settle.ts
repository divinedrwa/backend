import {
  BillingPaymentSource,
  BillingUserPaymentStatus,
  PaymentMode,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { recordPaymentAndSyncLedgers } from "../maintenance-payments/record-payment";
import { syncLedgerForPayment } from "./ledger-sync";

type PaymentRow = {
  id: string;
  userId: string | null;
  cycleId: string;
  amountPaid: Prisma.Decimal | number;
  cycle: { societyId: string; id: string };
};

function parsePayAllFromLog(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return p.payAllPending === true || p.payAllPending === "true";
}

export async function isPayAllGatewayPayment(
  row: PaymentRow,
  initiateStatus: "create_order" | "phonepe_initiate",
): Promise<boolean> {
  const log = await prisma.billingPaymentLog.findFirst({
    where: {
      userId: row.userId ?? undefined,
      cycleId: row.cycleId,
      status: initiateStatus,
    },
    orderBy: { createdAt: "desc" },
    select: { requestPayload: true },
  });
  return parsePayAllFromLog(log?.requestPayload);
}

/**
 * Apply successful Razorpay / PhonePe settlement to maintenance ledgers.
 * Single-cycle uses snapshot sync; pay-all uses the same walker as verified multi-month UPI.
 */
export async function applyGatewayPaymentSuccess(
  tx: Prisma.TransactionClient,
  params: {
    row: PaymentRow;
    maintenanceAmount: number;
    paidAt: Date;
    paymentMode: PaymentMode;
    remarks: string;
    payAllPending: boolean;
    gatewayTransactionId?: string;
  },
): Promise<void> {
  const { row, maintenanceAmount, paidAt, paymentMode, remarks, payAllPending, gatewayTransactionId } =
    params;

  if (!row.userId) return;

  if (payAllPending) {
    const user = await tx.user.findUnique({
      where: { id: row.userId },
      select: { villaId: true },
    });
    if (!user?.villaId) return;

    const billingCycle = await tx.billingCycle.findUnique({
      where: { id: row.cycleId },
      select: { cycleKey: true, societyId: true },
    });
    if (!billingCycle) return;

    const m = /^(\d{4})-(\d{2})$/.exec(billingCycle.cycleKey);
    const month = m ? Number(m[2]) : paidAt.getUTCMonth() + 1;
    const year = m ? Number(m[1]) : paidAt.getUTCFullYear();

    await recordPaymentAndSyncLedgers(tx, {
      societyId: billingCycle.societyId,
      villaId: user.villaId,
      month,
      year,
      amount: maintenanceAmount,
      paymentDate: paidAt.toISOString(),
      paymentMode,
      transactionId: gatewayTransactionId,
      remarks,
      recordedByUserId: row.userId,
      auditAction: "GATEWAY_PAY_ALL",
      walkAllCycles: true,
      billingSource: BillingPaymentSource.GATEWAY,
    });
    return;
  }

  await syncLedgerForPayment(tx, row, maintenanceAmount, paidAt, paymentMode, remarks);
}

/**
 * Poll reconciliation when PhonePe callback is delayed but status API shows COMPLETED.
 */
export async function reconcilePhonePeIfCompleted(
  societyId: string,
  merchantTransactionId: string,
): Promise<{ reconciled: boolean; status: BillingUserPaymentStatus | null }> {
  const row = await prisma.userCyclePayment.findFirst({
    where: { paymentGatewayOrderId: merchantTransactionId, cycle: { societyId } },
    include: { cycle: { select: { societyId: true, id: true } } },
  });

  if (!row) return { reconciled: false, status: null };
  if (row.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
    return { reconciled: false, status: row.paymentStatus };
  }

  const { checkPhonePeStatus } = await import("../../services/phonepe-billing");
  const phonepeResult = await checkPhonePeStatus(societyId, merchantTransactionId);
  if (!phonepeResult?.success || phonepeResult.state !== "COMPLETED") {
    return { reconciled: false, status: row.paymentStatus };
  }

  const payAllPending = await isPayAllGatewayPayment(row, "phonepe_initiate");
  const maintenanceAmount = Number(row.amountPaid);
  const paidAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.userCyclePayment.update({
      where: { id: row.id },
      data: {
        paymentStatus: BillingUserPaymentStatus.SUCCESS,
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
          status: "phonepe.poll.reconcile",
          responsePayload: { merchantTransactionId, state: phonepeResult.state } as object,
        },
      });
    }

    await applyGatewayPaymentSuccess(tx, {
      row,
      maintenanceAmount,
      paidAt,
      paymentMode: PaymentMode.PHONEPE,
      remarks: "PhonePe poll reconciliation",
      payAllPending,
      gatewayTransactionId: merchantTransactionId,
    });
  });

  return { reconciled: true, status: BillingUserPaymentStatus.SUCCESS };
}
