import {
  BillingPaymentSource,
  BillingUserPaymentStatus,
  MaintenanceBillingRole,
  Prisma,
  UserRole,
} from "@prisma/client";
import { clearExcludedResidentsUserCyclePayments } from "../../lib/maintenanceBillingRole";
import { refreshSnapshotStatus } from "../maintenance-management/snapshot-helpers";
import { LedgerSyncError } from "./ledger-sync-errors";

export function parseBillingCycleKey(cycleKey: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(cycleKey);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * Ensures a MaintenanceCollectionCycle exists for this BillingCycle (periodKey = cycleKey).
 * Required before gateway ledger sync — admin dashboard reads snapshots on the collection cycle.
 */
export async function ensureMaintenanceCollectionForBillingCycle(
  tx: Prisma.TransactionClient,
  billingCycleId: string,
): Promise<{ maintenanceCycleId: string; periodKey: string; dueDate: Date }> {
  const billingCycle = await tx.billingCycle.findUnique({
    where: { id: billingCycleId },
    select: {
      id: true,
      societyId: true,
      cycleKey: true,
      title: true,
      amount: true,
      paymentEndDate: true,
      status: true,
      financialYearId: true,
    },
  });

  if (!billingCycle) {
    throw new LedgerSyncError("BILLING_CYCLE_NOT_FOUND", "Billing cycle not found");
  }
  if (!billingCycle.financialYearId) {
    throw new LedgerSyncError(
      "NO_FINANCIAL_YEAR",
      "Billing cycle is not linked to a financial year. Ask admin to sync maintenance billing.",
    );
  }

  const parsed = parseBillingCycleKey(billingCycle.cycleKey);
  const periodMonth = parsed?.month ?? billingCycle.paymentEndDate.getMonth() + 1;
  const periodYear = parsed?.year ?? billingCycle.paymentEndDate.getFullYear();
  const periodKey =
    parsed != null
      ? billingCycle.cycleKey
      : `${periodYear}-${String(periodMonth).padStart(2, "0")}`;
  const dueDate = new Date(
    Date.UTC(
      billingCycle.paymentEndDate.getUTCFullYear(),
      billingCycle.paymentEndDate.getUTCMonth(),
      billingCycle.paymentEndDate.getUTCDate(),
    ),
  );

  const maintenanceCycle = await tx.maintenanceCollectionCycle.upsert({
    where: {
      financialYearId_periodKey: {
        financialYearId: billingCycle.financialYearId,
        periodKey,
      },
    },
    create: {
      societyId: billingCycle.societyId,
      financialYearId: billingCycle.financialYearId,
      periodKey,
      title: billingCycle.title,
      periodMonth,
      periodYear,
      dueDate,
      status: billingCycle.status === "CLOSED" ? "CLOSED" : "OPEN",
    },
    update: {
      title: billingCycle.title,
      periodMonth,
      periodYear,
      dueDate,
    },
  });

  const cycleBaseAmount = Number(billingCycle.amount);
  await tx.maintenanceCycleRule.upsert({
    where: { cycleId: maintenanceCycle.id },
    create: {
      cycleId: maintenanceCycle.id,
      ruleType: "CUSTOM",
      baseAmount: new Prisma.Decimal(cycleBaseAmount),
      customAmounts: {},
    },
    update: {
      baseAmount: new Prisma.Decimal(cycleBaseAmount),
    },
  });

  return { maintenanceCycleId: maintenanceCycle.id, periodKey, dueDate };
}

/** Create a villa snapshot row when missing (minimal bootstrap for gateway pay). */
export async function ensureVillaSnapshotForMaintenanceCycle(
  tx: Prisma.TransactionClient,
  params: {
    maintenanceCycleId: string;
    villaId: string;
    fallbackExpected: number;
    dueDate: Date;
  },
): Promise<{ snapshotId: string; expectedAmount: number }> {
  const existing = await tx.villaMaintenanceSnapshot.findUnique({
    where: {
      cycleId_villaId: { cycleId: params.maintenanceCycleId, villaId: params.villaId },
    },
    select: { id: true, expectedAmount: true },
  });
  if (existing) {
    return { snapshotId: existing.id, expectedAmount: Number(existing.expectedAmount) };
  }

  const expected = Math.max(0, params.fallbackExpected);
  const status = refreshSnapshotStatus(expected, 0, params.dueDate);
  const created = await tx.villaMaintenanceSnapshot.create({
    data: {
      cycleId: params.maintenanceCycleId,
      villaId: params.villaId,
      expectedAmount: new Prisma.Decimal(expected),
      paidAmount: new Prisma.Decimal(0),
      status,
      breakdown: { gatewayBootstrap: true } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { snapshotId: created.id, expectedAmount: expected };
}

/**
 * After snapshot/ledger update, align UserCyclePayment rows for primary residents
 * so Maintenance Billing admin matches maintenance-management.
 */
export async function syncBillingUserCyclePaymentsFromSnapshot(
  tx: Prisma.TransactionClient,
  params: {
    societyId: string;
    villaId: string;
    billingCycleId: string;
    paidAmount: number;
    snapStatus: string;
    source?: BillingPaymentSource;
  },
): Promise<void> {
  await clearExcludedResidentsUserCyclePayments(tx, {
    societyId: params.societyId,
    villaId: params.villaId,
    billingCycleId: params.billingCycleId,
  });

  const primaryResidents = await tx.user.findMany({
    where: {
      societyId: params.societyId,
      villaId: params.villaId,
      role: UserRole.RESIDENT,
      isActive: true,
      maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
    },
    select: { id: true },
  });

  const payStatus =
    params.snapStatus === "PAID" || params.snapStatus === "WAIVED"
      ? BillingUserPaymentStatus.SUCCESS
      : BillingUserPaymentStatus.PENDING;
  const paidAt = new Date();
  const source = params.source ?? BillingPaymentSource.GATEWAY;

  for (const u of primaryResidents) {
    await tx.userCyclePayment.upsert({
      where: { userId_cycleId: { userId: u.id, cycleId: params.billingCycleId } },
      create: {
        userId: u.id,
        cycleId: params.billingCycleId,
        amountPaid: new Prisma.Decimal(params.paidAmount),
        paymentStatus: payStatus,
        source,
        paidAt: payStatus === BillingUserPaymentStatus.SUCCESS ? paidAt : null,
      },
      update: {
        amountPaid: new Prisma.Decimal(params.paidAmount),
        paymentStatus: payStatus,
        source,
        paidAt: payStatus === BillingUserPaymentStatus.SUCCESS ? paidAt : null,
      },
    });
  }
}
