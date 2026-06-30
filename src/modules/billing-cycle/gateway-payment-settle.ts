import {
  BillingPaymentSource,
  BillingUserPaymentStatus,
  PaymentMode,
  Prisma,
} from "@prisma/client";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { notifyUser } from "../../services/notification.service";
import { recordPaymentAndSyncLedgers } from "../maintenance-payments/record-payment";
import { invalidateReconcileCache } from "./services/resident-pending-dues";
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

async function notifyGatewayBillingPayment(
  userId: string,
  cycleId: string,
  outcome: "success" | "failed",
): Promise<void> {
  try {
    if (outcome === "success") {
      await notifyUser(userId, {
        title: "Payment received",
        body: "Your maintenance payment was recorded successfully.",
        data: { cycleId, type: "billing_payment_success" },
      });
    } else {
      await notifyUser(userId, {
        title: "Payment failed",
        body: "Your maintenance payment could not be processed. Please try again.",
        data: { cycleId, type: "billing_payment_failed" },
      });
    }
  } catch {
    /* optional push */
  }
}

async function markGatewayPaymentFailed(
  row: PaymentRow & { cycle: { societyId: string; id: string } },
  logStatus: string,
  responsePayload: object,
): Promise<boolean> {
  const transitioned = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRawUnsafe<{ paymentStatus: string }[]>(
      `SELECT "paymentStatus" FROM "user_payments" WHERE id = $1 FOR UPDATE`,
      row.id,
    );
    if (!locked || locked.paymentStatus === BillingUserPaymentStatus.SUCCESS) return false;
    if (locked.paymentStatus === BillingUserPaymentStatus.FAILED) return false;

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
          status: logStatus,
          responsePayload,
        },
      });
    }
    return true;
  });

  if (transitioned && row.userId) {
    await notifyGatewayBillingPayment(row.userId, row.cycle.id, "failed");
  }
  return transitioned;
}

/**
 * Maintenance amount to credit on gateway settle/repair.
 * Falls back to create-order log or cycle amount when the payment row has 0
 * (stale reuse / idempotent retry).
 */
export async function resolveGatewayMaintenanceAmount(
  row: PaymentRow,
  initiateStatus: "create_order" | "phonepe_initiate",
): Promise<number> {
  const stored = Number(row.amountPaid);
  if (stored > 0.005) return stored;

  const log = await prisma.billingPaymentLog.findFirst({
    where: {
      userId: row.userId ?? undefined,
      cycleId: row.cycleId,
      status: initiateStatus,
    },
    orderBy: { createdAt: "desc" },
    select: { requestPayload: true },
  });
  const payload = log?.requestPayload as Record<string, unknown> | undefined;
  const fromLog = Number(payload?.maintenanceAmount);
  if (Number.isFinite(fromLog) && fromLog > 0.005) return fromLog;

  const cycle = await prisma.billingCycle.findUnique({
    where: { id: row.cycleId },
    select: { amount: true },
  });
  const fromCycle = Number(cycle?.amount ?? 0);
  if (fromCycle > 0.005) return fromCycle;

  return Math.max(0, stored);
}

function gatewayShouldAttemptLedgerRepair(gateway: PhonePeStatusResult): boolean {
  return (
    gateway.outcome === "completed" ||
    gateway.outcome === "recorded" ||
    gateway.gatewaySuccessFlag === true
  );
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
      // Stable per-charge key so a replay (webhook + poll + resume-recovery all
      // firing for the same order) reuses the row instead of double-crediting.
      // row.id (the UserCyclePayment) is the same across every settle path for
      // one gateway order, unlike gatewayTransactionId (orderId vs paymentId).
      idempotencyKey: `gw-payall:${row.id}`,
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
    select: { status: true, expectedAmount: true, paidAmount: true, lateFeeAmount: true },
  });
  if (!snap) return false;
  if (snap.status === "PAID" || snap.status === "WAIVED") return true;
  const totalExpected =
    Number(snap.expectedAmount) + Number(snap.lateFeeAmount ?? 0);
  return Number(snap.paidAmount) >= totalExpected - 0.005;
}

async function hasGatewayMaintenancePayment(
  row: PaymentRow,
  gatewayTransactionId: string,
): Promise<boolean> {
  if (!row.userId) return false;
  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { villaId: true },
  });
  if (!user?.villaId) return false;

  const paymentRow = await prisma.userCyclePayment.findUnique({
    where: { id: row.id },
    select: { paymentGatewayOrderId: true, paymentGatewayPaymentId: true },
  });
  const txnIds = [
    gatewayTransactionId,
    paymentRow?.paymentGatewayOrderId,
    paymentRow?.paymentGatewayPaymentId,
  ].filter((id): id is string => typeof id === "string" && id.length > 0);

  if (txnIds.length === 0) return false;

  const existing = await prisma.maintenancePayment.findFirst({
    where: {
      societyId: row.cycle.societyId,
      villaId: user.villaId,
      transactionId: { in: txnIds },
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
    if (err.code === "P2010" && /UserCyclePayment|user_payments/i.test(String(err.message))) {
      return "Server payment lock query failed. Deploy the latest API build.";
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
      const maintenanceAmount = await resolveGatewayMaintenanceAmount(row, "phonepe_initiate");
      const repaired = await repairGatewayLedger(row, {
        gatewayTransactionId: merchantTransactionId,
        maintenanceAmount,
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
    await markGatewayPaymentFailed(row, "phonepe.poll.failed", {
      merchantTransactionId,
      rawState: gateway.rawState,
      rawCode: gateway.rawCode,
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
  const maintenanceAmount = await resolveGatewayMaintenanceAmount(row, params.payAllInitiateStatus);
  const paidAt = new Date();

  try {
    const newlySettled = await prisma.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRawUnsafe<{ paymentStatus: string }[]>(
          `SELECT "paymentStatus" FROM "user_payments" WHERE id = $1 FOR UPDATE`,
          row.id,
        );
        if (!locked || locked.paymentStatus === BillingUserPaymentStatus.SUCCESS) {
          return false;
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
            amountPaid: maintenanceAmount,
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
        return true;
      },
      { timeout: 30_000 },
    );

    if (newlySettled && row.userId) {
      await notifyGatewayBillingPayment(row.userId, row.cycle.id, "success");
      const villa = await prisma.user.findUnique({
        where: { id: row.userId },
        select: { villaId: true },
      });
      if (villa?.villaId) invalidateReconcileCache(villa.villaId);
    }
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
        // Serialize concurrent repairs for this payment row (the public PhonePe
        // redirect page and the mobile status poll can both invoke repair at once).
        // Without this lock both pass the outer isGatewayLedgerSynced() check and
        // race; the lock makes the loser see the committed ledger and no-op via the
        // transactionId / idempotencyKey dedup inside applyGatewayPaymentSuccess.
        await tx.$queryRawUnsafe(
          `SELECT id FROM "user_payments" WHERE id = $1 FOR UPDATE`,
          row.id,
        );
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
        await tx.userCyclePayment.update({
          where: { id: row.id },
          data: {
            amountPaid: params.maintenanceAmount,
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
    if (!ledgerSynced && gatewayShouldAttemptLedgerRepair(gateway)) {
      const maintenanceAmount = await resolveGatewayMaintenanceAmount(row, "create_order");
      const repaired = await repairGatewayLedger(row, {
        gatewayTransactionId: razorpayPaymentId,
        maintenanceAmount,
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
    await markGatewayPaymentFailed(row, "razorpay.poll.failed", {
      orderId,
      rawState: gateway.rawState,
      rawCode: gateway.rawCode,
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
