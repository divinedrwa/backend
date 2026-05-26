import crypto from "crypto";
import { BillingPaymentSource, PaymentMode, Prisma } from "@prisma/client";
import { applyVillaCreditAcrossSnapshots } from "../maintenance-management/credit-walker";
import { refreshSnapshotStatus } from "../maintenance-management/snapshot-helpers";
import {
  ensureMaintenanceCollectionForBillingCycle,
  ensureVillaSnapshotForMaintenanceCycle,
  syncBillingUserCyclePaymentsFromSnapshot,
} from "./billing-collection-link";
import { LedgerSyncError } from "./ledger-sync-errors";

type TxClient = Prisma.TransactionClient;

type PaymentRow = {
  id: string;
  userId: string | null;
  cycleId: string;
  cycle: { societyId: string; id: string };
};

export type LedgerSyncResult = {
  maintenanceCycleId: string;
  snapshotStatus: string;
  paidAmount: number;
};

/**
 * Shared ledger sync logic used by both Razorpay and PhonePe webhooks.
 * Writes VillaMaintenanceSnapshot, Maintenance, MaintenancePayment, and
 * runs the credit walker — the exact same block that was in billing-webhook.ts.
 *
 * Throws LedgerSyncError when admin maintenance-management cannot be updated.
 */
export async function syncLedgerForPayment(
  tx: TxClient,
  row: PaymentRow,
  amountPaidNum: number,
  paidAt: Date,
  paymentMode: PaymentMode,
  remarks: string,
  gatewayTransactionId?: string,
): Promise<LedgerSyncResult> {
  if (!row.userId) {
    throw new LedgerSyncError("NO_USER", "Payment row has no resident user");
  }

  const user = await tx.user.findUnique({
    where: { id: row.userId },
    select: { villaId: true },
  });
  if (!user?.villaId) {
    throw new LedgerSyncError(
      "NO_VILLA",
      "Resident is not linked to a villa. Admin must assign a flat before gateway payments can post.",
    );
  }

  const billingCycle = await tx.billingCycle.findUnique({
    where: { id: row.cycleId },
    select: { cycleKey: true, financialYearId: true, societyId: true, amount: true },
  });
  if (!billingCycle?.financialYearId) {
    throw new LedgerSyncError(
      "NO_FINANCIAL_YEAR",
      "Billing cycle is not linked to a financial year.",
    );
  }

  const { maintenanceCycleId, dueDate } = await ensureMaintenanceCollectionForBillingCycle(
    tx,
    row.cycleId,
  );

  const fallbackExpected = Number(billingCycle.amount);
  await ensureVillaSnapshotForMaintenanceCycle(tx, {
    maintenanceCycleId,
    villaId: user.villaId,
    fallbackExpected: fallbackExpected > 0 ? fallbackExpected : amountPaidNum,
    dueDate,
  });

  const maintenanceCycle = await tx.maintenanceCollectionCycle.findUnique({
    where: { id: maintenanceCycleId },
    select: { id: true, periodMonth: true, periodYear: true, dueDate: true, societyId: true },
  });
  if (!maintenanceCycle) {
    throw new LedgerSyncError("MAINTENANCE_CYCLE_MISSING", "Maintenance collection cycle missing after link");
  }

  if (gatewayTransactionId) {
    const existing = await tx.maintenancePayment.findFirst({
      where: {
        societyId: billingCycle.societyId,
        villaId: user.villaId,
        transactionId: gatewayTransactionId,
      },
      select: { id: true },
    });
    if (existing) {
      const snap = await tx.villaMaintenanceSnapshot.findUnique({
        where: { cycleId_villaId: { cycleId: maintenanceCycleId, villaId: user.villaId } },
        select: { paidAmount: true, status: true },
      });
      await applyVillaCreditAcrossSnapshots(tx, {
        societyId: billingCycle.societyId,
        villaId: user.villaId,
        financialYearId: billingCycle.financialYearId,
        throughCycleId: maintenanceCycle.id,
      });
      const paidAmount = Number(snap?.paidAmount ?? 0);
      await syncBillingUserCyclePaymentsFromSnapshot(tx, {
        societyId: billingCycle.societyId,
        villaId: user.villaId,
        billingCycleId: row.cycleId,
        paidAmount,
        snapStatus: snap?.status ?? "PAID",
        source: BillingPaymentSource.GATEWAY,
      });
      return {
        maintenanceCycleId,
        snapshotStatus: snap?.status ?? "PAID",
        paidAmount,
      };
    }
  }

  const [snapshot] = await tx.$queryRawUnsafe<
    { id: string; expectedAmount: string; paidAmount: string }[]
  >(
    `SELECT id, "expectedAmount"::text, "paidAmount"::text FROM "VillaMaintenanceSnapshot" WHERE "cycleId" = $1 AND "villaId" = $2 FOR UPDATE`,
    maintenanceCycle.id,
    user.villaId,
  );

  if (!snapshot) {
    throw new LedgerSyncError(
      "NO_SNAPSHOT",
      "Could not create villa maintenance snapshot for this payment.",
    );
  }

  const expected = Number(snapshot.expectedAmount);
  const paidSoFar = Number(snapshot.paidAmount);
  const appliedToCycle = Math.max(0, Math.min(amountPaidNum, expected - paidSoFar));
  const newPaid = paidSoFar + appliedToCycle;
  const snapStatus = refreshSnapshotStatus(expected, newPaid, maintenanceCycle.dueDate);

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
        snapStatus === "PAID" ? "PAID" : snapStatus === "OVERDUE" ? "OVERDUE" : "PENDING",
    },
    update: {
      amount: snapshot.expectedAmount,
      dueDate: maintenanceCycle.dueDate,
      status:
        snapStatus === "PAID" ? "PAID" : snapStatus === "OVERDUE" ? "OVERDUE" : "PENDING",
    },
  });

  if (amountPaidNum > 0.005) {
    await tx.maintenancePayment.create({
      data: {
        societyId: billingCycle.societyId,
        villaId: user.villaId,
        maintenanceId: maintenanceRow.id,
        month: maintenanceCycle.periodMonth,
        year: maintenanceCycle.periodYear,
        amount: new Prisma.Decimal(amountPaidNum),
        paymentDate: paidAt,
        paymentMode,
        transactionId: gatewayTransactionId ?? undefined,
        receiptNumber: `RCP-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        remarks,
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

  await applyVillaCreditAcrossSnapshots(tx, {
    societyId: billingCycle.societyId,
    villaId: user.villaId,
    financialYearId: billingCycle.financialYearId,
    throughCycleId: maintenanceCycle.id,
  });

  await syncBillingUserCyclePaymentsFromSnapshot(tx, {
    societyId: billingCycle.societyId,
    villaId: user.villaId,
    billingCycleId: row.cycleId,
    paidAmount: newPaid,
    snapStatus,
    source: BillingPaymentSource.GATEWAY,
  });

  return { maintenanceCycleId, snapshotStatus: snapStatus, paidAmount: newPaid };
}
