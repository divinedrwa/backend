import {
  BillingPaymentSource,
  BillingUserPaymentStatus,
  PaymentMode,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { recordPaymentAndSyncLedgers } from "../maintenance-payments/record-payment";
import {
  checkPhonePeStatus,
  isPhonePePaymentSuccessful,
  mergePhonePeStatusWithLocal,
  type PhonePeSettlementOutcome,
  type PhonePeStatusResult,
} from "../../services/phonepe-billing";
import { checkRazorpayOrderStatus } from "./services/razorpay-billing";
import { mergeRazorpayStatusWithLocal } from "../../services/razorpay-status";
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

export type PhonePePollReconcileResult = {
  reconciled: boolean;
  status: BillingUserPaymentStatus | null;
  outcome: PhonePeSettlementOutcome;
  gateway: PhonePeStatusResult;
};

/**
 * Poll PhonePe status API and sync local payment row (success → ledger, failure → FAILED).
 */
export async function reconcilePhonePeFromPoll(
  societyId: string,
  merchantTransactionId: string,
): Promise<PhonePePollReconcileResult> {
  const row = await prisma.userCyclePayment.findFirst({
    where: { paymentGatewayOrderId: merchantTransactionId, cycle: { societyId } },
    include: { cycle: { select: { societyId: true, id: true } } },
  });

  const gatewayRaw = await checkPhonePeStatus(societyId, merchantTransactionId);
  const gateway = mergePhonePeStatusWithLocal(gatewayRaw, row?.paymentStatus);

  if (!row) {
    return { reconciled: false, status: null, outcome: gateway.outcome, gateway };
  }

  if (row.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
    return {
      reconciled: false,
      status: row.paymentStatus,
      outcome: "recorded",
      gateway,
    };
  }

  if (gateway.outcome === "failed") {
    await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRawUnsafe<{ paymentStatus: string }[]>(
        `SELECT "paymentStatus" FROM "UserCyclePayment" WHERE id = $1 FOR UPDATE`,
        row.id,
      );
      if (!locked || locked.paymentStatus === BillingUserPaymentStatus.SUCCESS) return;

      await tx.userCyclePayment.update({
        where: { id: row.id },
        data: {
          paymentStatus: BillingUserPaymentStatus.FAILED,
          paidAt: null,
          source: BillingPaymentSource.GATEWAY,
        },
      });

      if (row.userId) {
        await tx.billingPaymentLog.create({
          data: {
            societyId: row.cycle.societyId,
            userId: row.userId,
            cycleId: row.cycle.id,
            status: "phonepe.poll.failed",
            responsePayload: {
              merchantTransactionId,
              rawState: gateway.rawState,
              rawCode: gateway.rawCode,
            } as object,
          },
        });
      }
    });

    return {
      reconciled: true,
      status: BillingUserPaymentStatus.FAILED,
      outcome: "failed",
      gateway,
    };
  }

  if (
    gateway.outcome !== "completed" &&
    !isPhonePePaymentSuccessful(gateway.gatewaySuccessFlag, gateway.rawState, gateway.rawCode)
  ) {
    return { reconciled: false, status: row.paymentStatus, outcome: gateway.outcome, gateway };
  }

  const payAllPending = await isPayAllGatewayPayment(row, "phonepe_initiate");
  const maintenanceAmount = Number(row.amountPaid);
  const paidAt = new Date();

  await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRawUnsafe<{ paymentStatus: string }[]>(
      `SELECT "paymentStatus" FROM "UserCyclePayment" WHERE id = $1 FOR UPDATE`,
      row.id,
    );
    if (!locked || locked.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
      return;
    }

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
          responsePayload: {
            merchantTransactionId,
            rawState: gateway.rawState,
            rawCode: gateway.rawCode,
          } as object,
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

  return {
    reconciled: true,
    status: BillingUserPaymentStatus.SUCCESS,
    outcome: "completed",
    gateway,
  };
}

/** @deprecated Use reconcilePhonePeFromPoll */
export async function reconcilePhonePeIfCompleted(
  societyId: string,
  merchantTransactionId: string,
): Promise<{ reconciled: boolean; status: BillingUserPaymentStatus | null }> {
  const result = await reconcilePhonePeFromPoll(societyId, merchantTransactionId);
  return { reconciled: result.reconciled, status: result.status };
}

export type GatewayPollReconcileResult = PhonePePollReconcileResult;

/**
 * Poll Razorpay order API and sync local payment (success → ledger, failure → FAILED).
 * Used when SDK reports success before webhook lands.
 */
export async function reconcileRazorpayFromPoll(
  societyId: string,
  orderId: string,
): Promise<GatewayPollReconcileResult> {
  const row = await prisma.userCyclePayment.findFirst({
    where: { paymentGatewayOrderId: orderId, cycle: { societyId } },
    include: { cycle: { select: { societyId: true, id: true } } },
  });

  const gatewayRaw = await checkRazorpayOrderStatus(societyId, orderId);
  const gateway = mergeRazorpayStatusWithLocal(gatewayRaw, row?.paymentStatus);

  if (!row) {
    return { reconciled: false, status: null, outcome: gateway.outcome, gateway };
  }

  if (row.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
    return {
      reconciled: false,
      status: row.paymentStatus,
      outcome: "recorded",
      gateway,
    };
  }

  if (gateway.outcome === "failed") {
    await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRawUnsafe<{ paymentStatus: string }[]>(
        `SELECT "paymentStatus" FROM "UserCyclePayment" WHERE id = $1 FOR UPDATE`,
        row.id,
      );
      if (!locked || locked.paymentStatus === BillingUserPaymentStatus.SUCCESS) return;

      await tx.userCyclePayment.update({
        where: { id: row.id },
        data: {
          paymentStatus: BillingUserPaymentStatus.FAILED,
          paidAt: null,
          source: BillingPaymentSource.GATEWAY,
        },
      });

      if (row.userId) {
        await tx.billingPaymentLog.create({
          data: {
            societyId: row.cycle.societyId,
            userId: row.userId,
            cycleId: row.cycle.id,
            status: "razorpay.poll.failed",
            responsePayload: {
              orderId,
              rawState: gateway.rawState,
              rawCode: gateway.rawCode,
            } as object,
          },
        });
      }
    });

    return {
      reconciled: true,
      status: BillingUserPaymentStatus.FAILED,
      outcome: "failed",
      gateway,
    };
  }

  if (gateway.outcome !== "completed") {
    return { reconciled: false, status: row.paymentStatus, outcome: gateway.outcome, gateway };
  }

  const payAllPending = await isPayAllGatewayPayment(row, "create_order");
  const maintenanceAmount = Number(row.amountPaid);
  const paidAt = new Date();
  const razorpayPaymentId = gateway.gatewayTransactionId ?? orderId;

  await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRawUnsafe<{ paymentStatus: string }[]>(
      `SELECT "paymentStatus" FROM "UserCyclePayment" WHERE id = $1 FOR UPDATE`,
      row.id,
    );
    if (!locked || locked.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
      return;
    }

    await tx.userCyclePayment.update({
      where: { id: row.id },
      data: {
        paymentStatus: BillingUserPaymentStatus.SUCCESS,
        paymentGatewayPaymentId: razorpayPaymentId,
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
          status: "razorpay.poll.reconcile",
          responsePayload: {
            orderId,
            razorpayPaymentId,
            rawState: gateway.rawState,
            rawCode: gateway.rawCode,
          } as object,
        },
      });
    }

    await applyGatewayPaymentSuccess(tx, {
      row,
      maintenanceAmount,
      paidAt,
      paymentMode: PaymentMode.ONLINE,
      remarks: payAllPending ? "Razorpay pay-all poll reconciliation" : "Razorpay poll reconciliation",
      payAllPending,
      gatewayTransactionId: razorpayPaymentId,
    });
  });

  return {
    reconciled: true,
    status: BillingUserPaymentStatus.SUCCESS,
    outcome: "completed",
    gateway,
  };
}
