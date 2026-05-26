import {
  BillingPaymentSource,
  BillingUserPaymentStatus,
  PaymentMode,
  Prisma,
} from "@prisma/client";
import { logger } from "../../lib/logger";
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
import { ensureMaintenanceCollectionForBillingCycle } from "./billing-collection-link";
import { isLedgerSyncError, LedgerSyncError } from "./ledger-sync-errors";
import { syncLedgerForPayment } from "./ledger-sync";

type PaymentRow = {
  id: string;
  userId: string | null;
  cycleId: string;
  amountPaid: Prisma.Decimal | number;
  paymentStatus?: BillingUserPaymentStatus;
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

  if (!row.userId) {
    throw new LedgerSyncError("NO_USER", "Payment row has no resident user");
  }

  if (payAllPending) {
    const user = await tx.user.findUnique({
      where: { id: row.userId },
      select: { villaId: true },
    });
    if (!user?.villaId) {
      throw new LedgerSyncError("NO_VILLA", "Resident is not linked to a villa");
    }

    const billingCycle = await tx.billingCycle.findUnique({
      where: { id: row.cycleId },
      select: { cycleKey: true, societyId: true },
    });
    if (!billingCycle) {
      throw new LedgerSyncError("BILLING_CYCLE_NOT_FOUND", "Billing cycle not found");
    }

    await ensureMaintenanceCollectionForBillingCycle(tx, row.cycleId);

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

  await syncLedgerForPayment(
    tx,
    row,
    maintenanceAmount,
    paidAt,
    paymentMode,
    remarks,
    gatewayTransactionId,
  );
}

/** True when maintenance-management ledger reflects payment (admin grid + resident dues). */
export async function isGatewayLedgerSynced(
  row: PaymentRow,
  gatewayTransactionId: string,
): Promise<boolean> {
  if (await hasGatewayMaintenancePayment(row, gatewayTransactionId)) {
    return true;
  }
  if (!row.userId) return false;

  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { villaId: true },
  });
  if (!user?.villaId) return false;

  const billingCycle = await prisma.billingCycle.findUnique({
    where: { id: row.cycleId },
    select: { cycleKey: true, financialYearId: true, societyId: true },
  });
  if (!billingCycle?.financialYearId) return false;

  const maintenanceCycle = await prisma.maintenanceCollectionCycle.findFirst({
    where: {
      societyId: billingCycle.societyId,
      financialYearId: billingCycle.financialYearId,
      periodKey: billingCycle.cycleKey,
    },
    select: { id: true },
  });
  if (!maintenanceCycle) return false;

  const snap = await prisma.villaMaintenanceSnapshot.findUnique({
    where: { cycleId_villaId: { cycleId: maintenanceCycle.id, villaId: user.villaId } },
    select: { status: true, expectedAmount: true, paidAmount: true },
  });
  if (!snap) return false;
  if (snap.status === "PAID" || snap.status === "WAIVED") return true;
  return Number(snap.paidAmount) >= Number(snap.expectedAmount) - 0.005;
}

async function hasGatewayMaintenancePayment(
  row: PaymentRow,
  gatewayTransactionId: string,
): Promise<boolean> {
  if (!row.userId || !gatewayTransactionId) return false;
  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { villaId: true },
  });
  if (!user?.villaId) return false;
  const existing = await prisma.maintenancePayment.findFirst({
    where: {
      societyId: row.cycle.societyId,
      villaId: user.villaId,
      transactionId: gatewayTransactionId,
    },
    select: { id: true },
  });
  return existing != null;
}

/** User-safe message for poll/webhook reconcile failures (logged in full server-side). */
export function formatGatewayReconcileError(err: unknown): string {
  if (isLedgerSyncError(err)) {
    return err.message;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2028") {
      return "Payment recording timed out. Tap Check again in a few seconds.";
    }
    if (err.code === "P2034") {
      return "Payment is being processed concurrently. Tap Check again.";
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/PaymentMode|"PHONEPE"|22P02|enum/i.test(msg)) {
    return "Server database is missing the PhonePe payment mode. Run prisma migrate deploy on the API.";
  }
  if (/PAYMENT_SECRETS_KEY|decrypt|encrypted secret/i.test(msg)) {
    return "PhonePe credentials could not be decrypted. Check PAYMENT_SECRETS_KEY on the server.";
  }
  return "Could not record payment on server. Tap Check again or contact society admin.";
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
    let ledgerSynced = await isGatewayLedgerSynced(row, merchantTransactionId);
    if (
      !ledgerSynced &&
      (gateway.outcome === "completed" ||
        isPhonePePaymentSuccessful(gateway.gatewaySuccessFlag, gateway.rawState, gateway.rawCode))
    ) {
      const repaired = await repairGatewayLedger(row, {
        gatewayTransactionId: merchantTransactionId,
        maintenanceAmount: Number(row.amountPaid),
        paymentMode: PaymentMode.PHONEPE,
        payAllInitiateStatus: "phonepe_initiate",
        remarks: "PhonePe ledger repair (billing was SUCCESS, admin ledger missing)",
        logStatus: "phonepe.poll.repair",
        gatewayPayload: { merchantTransactionId, rawState: gateway.rawState, rawCode: gateway.rawCode },
      });
      ledgerSynced = repaired.ok;
      if (repaired.ok) {
        return {
          reconciled: true,
          status: BillingUserPaymentStatus.SUCCESS,
          outcome: "completed",
          gateway,
        };
      }
      return {
        reconciled: false,
        status: row.paymentStatus,
        outcome: "reconcile_failed",
        gateway: {
          ...gateway,
          detail:
            repaired.detail ??
            "Payment is marked paid but maintenance ledger was not updated. Tap Check again.",
        },
      };
    }
    if (!ledgerSynced) {
      return {
        reconciled: false,
        status: row.paymentStatus,
        outcome: "reconcile_failed",
        gateway: {
          ...gateway,
          detail:
            "Payment is marked paid but villa ledger is not updated. Ask admin to sync billing cycle to maintenance collection.",
        },
      };
    }
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

  const settled = await settleGatewayPayment(row, {
    societyId,
    gatewayTransactionId: merchantTransactionId,
    paymentMode: PaymentMode.PHONEPE,
    payAllInitiateStatus: "phonepe_initiate",
    remarks: "PhonePe poll reconciliation",
    logStatus: "phonepe.poll.reconcile",
    gatewayPayload: { merchantTransactionId, rawState: gateway.rawState, rawCode: gateway.rawCode },
    gateway,
  });
  return settled;
}

type SettleGatewayParams = {
  societyId: string;
  gatewayTransactionId: string;
  paymentMode: PaymentMode;
  payAllInitiateStatus: "phonepe_initiate" | "create_order";
  remarks: string;
  logStatus: string;
  gatewayPayload: object;
  gateway: PhonePeStatusResult;
};

async function settleGatewayPayment(
  row: PaymentRow & { cycle: { societyId: string; id: string } },
  params: SettleGatewayParams,
): Promise<PhonePePollReconcileResult> {
  const maintenanceAmount = Number(row.amountPaid);
  const paidAt = new Date();

  try {
    await prisma.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRawUnsafe<{ paymentStatus: string }[]>(
          `SELECT "paymentStatus" FROM "UserCyclePayment" WHERE id = $1 FOR UPDATE`,
          row.id,
        );
        if (!locked || locked.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
          return;
        }

        const payAllPending = await isPayAllGatewayPayment(row, params.payAllInitiateStatus);

        await applyGatewayPaymentSuccess(tx, {
          row,
          maintenanceAmount,
          paidAt,
          paymentMode: params.paymentMode,
          remarks: params.remarks,
          payAllPending,
          gatewayTransactionId: params.gatewayTransactionId,
        });

        await tx.userCyclePayment.update({
          where: { id: row.id },
          data: {
            paymentStatus: BillingUserPaymentStatus.SUCCESS,
            paidAt,
            source: BillingPaymentSource.GATEWAY,
            paymentGatewayPaymentId: params.gatewayTransactionId,
          },
        });

        if (row.userId) {
          await tx.billingPaymentLog.create({
            data: {
              societyId: row.cycle.societyId,
              userId: row.userId,
              cycleId: row.cycle.id,
              status: params.logStatus,
              responsePayload: params.gatewayPayload as object,
            },
          });
        }
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    const detail = formatGatewayReconcileError(err);
    logger.error(
      { err, gatewayTransactionId: params.gatewayTransactionId, societyId: params.societyId },
      "[gateway] settle failed",
    );
    return {
      reconciled: false,
      status: row.paymentStatus ?? null,
      outcome: "reconcile_failed",
      gateway: { ...params.gateway, detail },
    };
  }

  return {
    reconciled: true,
    status: BillingUserPaymentStatus.SUCCESS,
    outcome: "completed",
    gateway: params.gateway,
  };
}

async function repairGatewayLedger(
  row: PaymentRow & { cycle: { societyId: string; id: string } },
  params: {
    gatewayTransactionId: string;
    maintenanceAmount: number;
    paymentMode: PaymentMode;
    payAllInitiateStatus: "phonepe_initiate" | "create_order";
    remarks: string;
    logStatus: string;
    gatewayPayload: object;
  },
): Promise<{ ok: boolean; detail?: string }> {
  const paidAt = new Date();
  try {
    await prisma.$transaction(
      async (tx) => {
        const payAllPending = await isPayAllGatewayPayment(row, params.payAllInitiateStatus);
        await applyGatewayPaymentSuccess(tx, {
          row,
          maintenanceAmount: params.maintenanceAmount,
          paidAt,
          paymentMode: params.paymentMode,
          remarks: params.remarks,
          payAllPending,
          gatewayTransactionId: params.gatewayTransactionId,
        });
        if (row.userId) {
          await tx.billingPaymentLog.create({
            data: {
              societyId: row.cycle.societyId,
              userId: row.userId,
              cycleId: row.cycle.id,
              status: params.logStatus,
              responsePayload: params.gatewayPayload as object,
            },
          });
        }
      },
      { timeout: 30_000 },
    );
    return { ok: true };
  } catch (err) {
    const detail = formatGatewayReconcileError(err);
    logger.error({ err, rowId: row.id }, "[gateway] ledger repair failed");
    return { ok: false, detail };
  }
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

  const razorpayPaymentId = gateway.gatewayTransactionId ?? orderId;

  if (row.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
    let ledgerSynced = await isGatewayLedgerSynced(row, razorpayPaymentId);
    if (!ledgerSynced && gateway.outcome === "completed") {
      const repaired = await repairGatewayLedger(row, {
        gatewayTransactionId: razorpayPaymentId,
        maintenanceAmount: Number(row.amountPaid),
        paymentMode: PaymentMode.ONLINE,
        payAllInitiateStatus: "create_order",
        remarks: "Razorpay ledger repair (billing was SUCCESS, admin ledger missing)",
        logStatus: "razorpay.poll.repair",
        gatewayPayload: { orderId, razorpayPaymentId, rawState: gateway.rawState, rawCode: gateway.rawCode },
      });
      ledgerSynced = repaired.ok;
      if (repaired.ok) {
        return {
          reconciled: true,
          status: BillingUserPaymentStatus.SUCCESS,
          outcome: "completed",
          gateway,
        };
      }
      return {
        reconciled: false,
        status: row.paymentStatus,
        outcome: "reconcile_failed",
        gateway: { ...gateway, detail: repaired.detail },
      };
    }
    if (!ledgerSynced) {
      return {
        reconciled: false,
        status: row.paymentStatus,
        outcome: "reconcile_failed",
        gateway: {
          ...gateway,
          detail:
            "Payment is marked paid but maintenance ledger was not updated. Tap Check again or contact admin.",
        },
      };
    }
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

  return settleGatewayPayment(row, {
    societyId,
    gatewayTransactionId: razorpayPaymentId,
    paymentMode: PaymentMode.ONLINE,
    payAllInitiateStatus: "create_order",
    remarks: "Razorpay poll reconciliation",
    logStatus: "razorpay.poll.reconcile",
    gatewayPayload: {
      orderId,
      razorpayPaymentId,
      rawState: gateway.rawState,
      rawCode: gateway.rawCode,
    },
    gateway,
  });
}
