import crypto from "crypto";
import {
  BillingPaymentSource,
  BillingUserPaymentStatus,
  MaintenanceBillingRole,
  PaymentMode,
  Prisma,
} from "@prisma/client";
import { clearExcludedResidentsUserCyclePayments } from "../../lib/maintenanceBillingRole";
import {
  chargeHeadBreakdownToJson,
  computeChargeHeadBreakdown,
  type ChargeHeadRow,
  type ChargeLineResult,
} from "../../lib/chargeHeads.js";
import {
  computeExpectedForVilla,
  maintenanceCycleRuleFromConfig,
  parseSocietyBillingConfig,
  type CycleRuleInput,
  type VillaAmountInput,
} from "../../lib/maintenanceAmount.js";
import { residentLikeRoleFilter } from "../../lib/residentLike";
import { applyVillaCreditAcrossSnapshots } from "../maintenance-management/credit-walker";
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
      society: {
        select: {
          maintenanceBillingMode: true,
          maintenanceFixedAmount: true,
          maintenanceSqftRate: true,
        },
      },
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
  const billingConfig = parseSocietyBillingConfig(billingCycle.society, cycleBaseAmount);
  const ruleShape = maintenanceCycleRuleFromConfig(billingConfig);
  await tx.maintenanceCycleRule.upsert({
    where: { cycleId: maintenanceCycle.id },
    create: {
      cycleId: maintenanceCycle.id,
      ruleType: ruleShape.ruleType,
      baseAmount: ruleShape.baseAmount,
      perSqftRate: ruleShape.perSqftRate,
      customAmounts: {},
    },
    update: {
      ruleType: ruleShape.ruleType,
      baseAmount: ruleShape.baseAmount,
      perSqftRate: ruleShape.perSqftRate,
    },
  });

  return { maintenanceCycleId: maintenanceCycle.id, periodKey, dueDate };
}

function resolveVillaSnapshotBilling(params: {
  cycleRule: CycleRuleInput;
  villa: VillaAmountInput;
  useChargeHeads: boolean;
  chargeHeads: ChargeHeadRow[];
}): { expected: number; breakdown: Record<string, unknown>; chargeLines: ChargeLineResult[] | null } {
  const sqft = params.villa.area != null ? Number(params.villa.area) : 0;
  const headBreakdown = computeChargeHeadBreakdown(
    params.chargeHeads,
    sqft,
    params.useChargeHeads,
  );
  if (headBreakdown) {
    return {
      expected: headBreakdown.totalAmount,
      breakdown: {
        ...chargeHeadBreakdownToJson(headBreakdown),
        billingSource: "chargeHeads",
      },
      chargeLines: headBreakdown.chargeLines,
    };
  }
  const { expected, breakdown } = computeExpectedForVilla(params.cycleRule, params.villa);
  return { expected, breakdown, chargeLines: null };
}

async function persistSnapshotChargeLines(
  tx: Prisma.TransactionClient,
  snapshotId: string,
  chargeLines: ChargeLineResult[] | null | undefined,
): Promise<void> {
  await tx.villaCycleChargeLine.deleteMany({ where: { snapshotId } });
  if (!chargeLines?.length) return;
  await tx.villaCycleChargeLine.createMany({
    data: chargeLines.map((l) => ({
      snapshotId,
      chargeHeadId: l.chargeHeadId,
      label: l.label,
      amount: new Prisma.Decimal(l.amount),
      sortOrder: l.sortOrder,
    })),
  });
}

/** Remove the linked maintenance collection cycle when a draft billing cycle is deleted. */
export async function removeMaintenanceCollectionForBillingCycle(
  tx: Prisma.TransactionClient,
  billingCycle: {
    societyId: string;
    financialYearId: string | null;
    cycleKey: string;
  },
): Promise<void> {
  if (!billingCycle.financialYearId) return;

  const collectionCycle = await tx.maintenanceCollectionCycle.findFirst({
    where: {
      societyId: billingCycle.societyId,
      financialYearId: billingCycle.financialYearId,
      periodKey: billingCycle.cycleKey,
    },
    select: { id: true },
  });
  if (!collectionCycle) return;

  await tx.maintenancePayment.deleteMany({
    where: { maintenanceCollectionCycleId: collectionCycle.id },
  });
  await tx.cycleVillaExclusion.deleteMany({ where: { cycleId: collectionCycle.id } });
  await tx.villaMaintenanceSnapshot.deleteMany({ where: { cycleId: collectionCycle.id } });
  await tx.maintenanceCycleRule.deleteMany({ where: { cycleId: collectionCycle.id } });
  await tx.maintenanceCollectionCycle.delete({ where: { id: collectionCycle.id } });
}

/** Create a villa snapshot row when missing (minimal bootstrap for gateway pay). */
export async function ensureVillaSnapshotForMaintenanceCycle(
  tx: Prisma.TransactionClient,
  params: {
    maintenanceCycleId: string;
    villaId: string;
    fallbackExpected: number;
    dueDate: Date;
    breakdown?: Record<string, unknown>;
    chargeLines?: ChargeLineResult[] | null;
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
      breakdown: (params.breakdown ?? { gatewayBootstrap: true }) as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  await persistSnapshotChargeLines(tx, created.id, params.chargeLines);
  return { snapshotId: created.id, expectedAmount: expected };
}

/**
 * Ensure a maintenance collection cycle exists for a billing cycle AND a PENDING
 * snapshot exists for every primary-occupant (billed) villa. Idempotent: the
 * collection cycle is upserted and per-villa snapshots are skipped when already
 * present, so existing/paid rows are never overwritten. Returns the number of
 * billed villas ensured. Caller must pass the cycle's base amount.
 */
export async function generateSnapshotsForBillingCycle(
  tx: Prisma.TransactionClient,
  params: { societyId: string; billingCycleId: string; cycleAmount: number },
): Promise<number> {
  const { maintenanceCycleId, dueDate } = await ensureMaintenanceCollectionForBillingCycle(
    tx,
    params.billingCycleId,
  );
  const rule = await tx.maintenanceCycleRule.findUnique({
    where: { cycleId: maintenanceCycleId },
  });
  const occupants = await tx.user.findMany({
    where: {
      societyId: params.societyId,
      isActive: true,
      maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
      villaId: { not: null },
      ...residentLikeRoleFilter,
    },
    select: { villaId: true },
  });
  const villaIds = [
    ...new Set(
      occupants
        .map((o) => o.villaId)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
  const villas = await tx.villa.findMany({
    where: { societyId: params.societyId, id: { in: villaIds } },
    select: { id: true, area: true, monthlyMaintenance: true },
  });
  const villaById = new Map(villas.map((v) => [v.id, v]));
  const cycleRule = rule ?? {
    ruleType: "FIXED_PER_FLAT" as const,
    baseAmount: new Prisma.Decimal(params.cycleAmount),
    perSqftRate: null,
    customAmounts: null,
  };

  const society = await tx.society.findUnique({
    where: { id: params.societyId },
    select: {
      useChargeHeads: true,
      chargeHeads: {
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          code: true,
          label: true,
          amountType: true,
          fixedAmount: true,
          perSqftRate: true,
          sortOrder: true,
          isActive: true,
        },
      },
    },
  });
  const chargeHeads = society?.chargeHeads ?? [];
  const useChargeHeads = society?.useChargeHeads ?? false;

  for (const villaId of villaIds) {
    const villa = villaById.get(villaId) ?? {
      id: villaId,
      area: null,
      monthlyMaintenance: new Prisma.Decimal(params.cycleAmount),
    };
    const { expected, breakdown, chargeLines } = resolveVillaSnapshotBilling({
      cycleRule,
      villa,
      useChargeHeads,
      chargeHeads,
    });
    await ensureVillaSnapshotForMaintenanceCycle(tx, {
      maintenanceCycleId,
      villaId,
      fallbackExpected: expected,
      dueDate,
      breakdown,
      chargeLines,
    });
  }
  return villaIds.length;
}

/** Update expected amount on unpaid villa snapshots after admin edits a published cycle. */
export async function refreshUnpaidSnapshotsForBillingCycleAmount(
  tx: Prisma.TransactionClient,
  params: { billingCycleId: string; cycleAmount: number; dueDate: Date },
): Promise<void> {
  const billingCycle = await tx.billingCycle.findUnique({
    where: { id: params.billingCycleId },
    select: { societyId: true },
  });
  if (!billingCycle) return;

  const { maintenanceCycleId } = await ensureMaintenanceCollectionForBillingCycle(
    tx,
    params.billingCycleId,
  );
  const rule = await tx.maintenanceCycleRule.findUnique({
    where: { cycleId: maintenanceCycleId },
  });
  const cycleRule = rule ?? {
    ruleType: "FIXED_PER_FLAT" as const,
    baseAmount: new Prisma.Decimal(params.cycleAmount),
    perSqftRate: null,
    customAmounts: null,
  };
  const snaps = await tx.villaMaintenanceSnapshot.findMany({
    where: {
      cycleId: maintenanceCycleId,
      status: { in: ["PENDING", "OVERDUE", "PARTIAL"] },
    },
    select: { id: true, villaId: true, paidAmount: true },
  });
  if (snaps.length === 0) return;

  const villas = await tx.villa.findMany({
    where: { id: { in: snaps.map((s) => s.villaId) } },
    select: { id: true, area: true, monthlyMaintenance: true },
  });
  const villaById = new Map(villas.map((v) => [v.id, v]));

  const society = await tx.society.findUnique({
    where: { id: billingCycle.societyId },
    select: {
      useChargeHeads: true,
      chargeHeads: {
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          code: true,
          label: true,
          amountType: true,
          fixedAmount: true,
          perSqftRate: true,
          sortOrder: true,
          isActive: true,
        },
      },
    },
  });
  const chargeHeads = society?.chargeHeads ?? [];
  const useChargeHeads = society?.useChargeHeads ?? false;

  for (const snap of snaps) {
    const villa = villaById.get(snap.villaId) ?? {
      id: snap.villaId,
      area: null,
      monthlyMaintenance: new Prisma.Decimal(params.cycleAmount),
    };
    const { expected, breakdown, chargeLines } = resolveVillaSnapshotBilling({
      cycleRule,
      villa,
      useChargeHeads,
      chargeHeads,
    });
    const paid = Number(snap.paidAmount);
    const status = refreshSnapshotStatus(expected, paid, params.dueDate);
    await tx.villaMaintenanceSnapshot.update({
      where: { id: snap.id },
      data: {
        expectedAmount: new Prisma.Decimal(expected),
        status,
        breakdown: breakdown as Prisma.InputJsonValue,
      },
    });
    await persistSnapshotChargeLines(tx, snap.id, chargeLines);
  }
}

/**
 * After a global credit walk, align every billing UserCyclePayment row for a
 * villa across all financial years. Uses real cycle cash only on amountPaid
 * (never snapshot total, which includes applied credit).
 */
export async function syncVillaBillingCyclesFromSnapshots(
  tx: Prisma.TransactionClient,
  params: {
    societyId: string;
    villaId: string;
    source?: BillingPaymentSource;
  },
): Promise<void> {
  const mcCycles = await tx.maintenanceCollectionCycle.findMany({
    where: { societyId: params.societyId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: { id: true, periodKey: true, financialYearId: true },
  });

  for (const mc of mcCycles) {
    const snap = await tx.villaMaintenanceSnapshot.findUnique({
      where: { cycleId_villaId: { cycleId: mc.id, villaId: params.villaId } },
      select: { paidAmount: true, status: true },
    });
    if (!snap) continue;

    const billingCycle = await tx.billingCycle.findFirst({
      where: {
        societyId: params.societyId,
        financialYearId: mc.financialYearId,
        cycleKey: mc.periodKey,
      },
      select: { id: true },
    });
    if (!billingCycle) continue;

    const cashAgg = await tx.maintenancePayment.aggregate({
      where: {
        societyId: params.societyId,
        villaId: params.villaId,
        maintenanceCollectionCycleId: mc.id,
        reversedAt: null,
      },
      _sum: { amount: true },
    });
    const realCash = Math.max(0, Number(cashAgg._sum.amount ?? 0));

    await syncBillingUserCyclePaymentsFromSnapshot(tx, {
      societyId: params.societyId,
      villaId: params.villaId,
      billingCycleId: billingCycle.id,
      paidAmount: Number(snap.paidAmount),
      snapStatus: snap.status,
      source: params.source ?? BillingPaymentSource.CASH_MANUAL,
      cashPaidAmount: realCash,
    });
  }
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
    /** When set (e.g. gateway cash), stored on user_payments instead of snapshot total settled. */
    cashPaidAmount?: number;
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
      ...residentLikeRoleFilter,
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

  // UserCyclePayment.amountPaid must represent REAL CASH only — never the
  // snapshot's total settled amount, which includes applied advance credit.
  // Storing the total let reconcileVillaLedgerFromUserCyclePayment (which
  // treats amountPaid as cash) back-fill the credit portion as a phantom
  // "Billing cash sync" MaintenancePayment row — double-counting the villa's
  // credit and inflating the society fund. When the caller doesn't pass the
  // real cash explicitly, derive it from the maintenance cash ledger.
  let ucpAmountPaid = params.cashPaidAmount;
  if (ucpAmountPaid === undefined) {
    const { maintenanceCycleId } = await ensureMaintenanceCollectionForBillingCycle(
      tx,
      params.billingCycleId,
    );
    const cashAgg = await tx.maintenancePayment.aggregate({
      where: {
        societyId: params.societyId,
        villaId: params.villaId,
        maintenanceCollectionCycleId: maintenanceCycleId,
      },
      _sum: { amount: true },
    });
    ucpAmountPaid = Number(cashAgg._sum.amount ?? 0);
  }

  for (const u of primaryResidents) {
    await tx.userCyclePayment.upsert({
      where: { userId_cycleId: { userId: u.id, cycleId: params.billingCycleId } },
      create: {
        userId: u.id,
        cycleId: params.billingCycleId,
        amountPaid: new Prisma.Decimal(ucpAmountPaid),
        paymentStatus: payStatus,
        source,
        paidAt: payStatus === BillingUserPaymentStatus.SUCCESS ? paidAt : null,
      },
      update: {
        amountPaid: new Prisma.Decimal(ucpAmountPaid),
        paymentStatus: payStatus,
        source,
        paidAt: payStatus === BillingUserPaymentStatus.SUCCESS ? paidAt : null,
      },
    });
  }
}

/** Sync every villa snapshot on a maintenance collection cycle → linked billing `user_payments` rows. */
export async function syncAllUserCyclePaymentsForMaintenanceCycle(
  tx: Prisma.TransactionClient,
  params: {
    societyId: string;
    maintenanceCycleId: string;
    financialYearId: string;
    periodKey: string;
    source?: BillingPaymentSource;
  },
): Promise<void> {
  const billingCycle = await tx.billingCycle.findFirst({
    where: {
      societyId: params.societyId,
      financialYearId: params.financialYearId,
      cycleKey: params.periodKey,
    },
    select: { id: true },
  });
  if (!billingCycle) return;

  const snaps = await tx.villaMaintenanceSnapshot.findMany({
    where: { cycleId: params.maintenanceCycleId },
    select: { villaId: true, paidAmount: true, status: true },
  });

  for (const snap of snaps) {
    await syncBillingUserCyclePaymentsFromSnapshot(tx, {
      societyId: params.societyId,
      villaId: snap.villaId,
      billingCycleId: billingCycle.id,
      paidAmount: Number(snap.paidAmount),
      snapStatus: snap.status,
      source: params.source,
    });
  }
}

/** Realign all billing payment rows for a villa from current maintenance snapshots (after primary/villa change). */
export async function realignVillaBillingFromSnapshots(
  tx: Prisma.TransactionClient,
  params: { societyId: string; villaId: string },
): Promise<void> {
  const snaps = await tx.villaMaintenanceSnapshot.findMany({
    where: { villaId: params.villaId, cycle: { societyId: params.societyId } },
    select: {
      paidAmount: true,
      status: true,
      cycle: { select: { id: true, financialYearId: true, periodKey: true } },
    },
  });

  for (const snap of snaps) {
    const billingCycle = await tx.billingCycle.findFirst({
      where: {
        societyId: params.societyId,
        financialYearId: snap.cycle.financialYearId,
        cycleKey: snap.cycle.periodKey,
      },
      select: { id: true },
    });
    if (!billingCycle) continue;

    await syncBillingUserCyclePaymentsFromSnapshot(tx, {
      societyId: params.societyId,
      villaId: params.villaId,
      billingCycleId: billingCycle.id,
      paidAmount: Number(snap.paidAmount),
      snapStatus: snap.status,
      source: BillingPaymentSource.CASH_MANUAL,
    });
  }
}

/**
 * Posts a billing mark-cash amount into the maintenance-management cash ledger
 * (MaintenancePayment + credit walker). Always ensures collection cycle + snapshot exist.
 */
export async function postMarkCashToMaintenanceLedger(
  tx: Prisma.TransactionClient,
  params: {
    societyId: string;
    villaId: string;
    billingCycleId: string;
    cashAmount: number;
    paidAt: Date;
    note?: string;
  },
): Promise<void> {
  if (params.cashAmount <= 0.005) return;

  const billingCycle = await tx.billingCycle.findFirst({
    where: { id: params.billingCycleId, societyId: params.societyId },
    select: { id: true, financialYearId: true, amount: true },
  });
  if (!billingCycle?.financialYearId) return;

  const { maintenanceCycleId, dueDate } = await ensureMaintenanceCollectionForBillingCycle(
    tx,
    params.billingCycleId,
  );
  const { snapshotId } = await ensureVillaSnapshotForMaintenanceCycle(tx, {
    maintenanceCycleId,
    villaId: params.villaId,
    fallbackExpected: Number(billingCycle.amount),
    dueDate,
  });

  const maintenanceCycle = await tx.maintenanceCollectionCycle.findUnique({
    where: { id: maintenanceCycleId },
    select: { id: true, periodMonth: true, periodYear: true, dueDate: true },
  });
  if (!maintenanceCycle) return;

  const maintenanceRow = await tx.maintenance.upsert({
    where: {
      villaId_month_year: {
        villaId: params.villaId,
        month: maintenanceCycle.periodMonth,
        year: maintenanceCycle.periodYear,
      },
    },
    create: {
      societyId: params.societyId,
      villaId: params.villaId,
      month: maintenanceCycle.periodMonth,
      year: maintenanceCycle.periodYear,
      amount: new Prisma.Decimal(Number(billingCycle.amount)),
      dueDate: maintenanceCycle.dueDate,
      status: "PENDING",
    },
    update: {
      dueDate: maintenanceCycle.dueDate,
    },
  });

  await tx.maintenancePayment.create({
    data: {
      societyId: params.societyId,
      villaId: params.villaId,
      maintenanceId: maintenanceRow.id,
      month: maintenanceCycle.periodMonth,
      year: maintenanceCycle.periodYear,
      amount: new Prisma.Decimal(params.cashAmount),
      paymentDate: params.paidAt,
      paymentMode: PaymentMode.CASH,
      receiptNumber: `RCP-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      remarks:
        params.note && params.note.trim().length > 0
          ? `Billing cash sync: ${params.note.trim()}`
          : "Billing cash sync",
      maintenanceCollectionCycleId: maintenanceCycle.id,
      villaMaintenanceSnapshotId: snapshotId,
    },
  });

  await applyVillaCreditAcrossSnapshots(tx, {
    societyId: params.societyId,
    villaId: params.villaId,
    financialYearId: billingCycle.financialYearId,
    throughCycleId: maintenanceCycle.id,
  });

  const snap = await tx.villaMaintenanceSnapshot.findUnique({
    where: { cycleId_villaId: { cycleId: maintenanceCycleId, villaId: params.villaId } },
    select: { paidAmount: true, status: true },
  });
  if (snap) {
    await syncBillingUserCyclePaymentsFromSnapshot(tx, {
      societyId: params.societyId,
      villaId: params.villaId,
      billingCycleId: params.billingCycleId,
      paidAmount: Number(snap.paidAmount),
      snapStatus: snap.status,
      source: BillingPaymentSource.CASH_MANUAL,
    });
  }
}

/**
 * Settle a billing cycle using advance credit only (no gateway cash).
 * Runs the credit walker and aligns user_payments with the maintenance snapshot.
 */
export async function settleBillingCycleFromAdvanceCredit(
  tx: Prisma.TransactionClient,
  params: {
    societyId: string;
    userId: string;
    billingCycleId: string;
    source?: BillingPaymentSource;
  },
): Promise<{ snapStatus: string; paidAmount: number }> {
  const user = await tx.user.findUnique({
    where: { id: params.userId },
    select: { villaId: true },
  });
  if (!user?.villaId) {
    throw new LedgerSyncError("NO_VILLA", "Resident is not linked to a villa.");
  }

  const billingCycle = await tx.billingCycle.findFirst({
    where: { id: params.billingCycleId, societyId: params.societyId },
    select: { financialYearId: true, amount: true, paymentEndDate: true },
  });
  if (!billingCycle?.financialYearId) {
    throw new LedgerSyncError("NO_FINANCIAL_YEAR", "Billing cycle is not linked to a financial year.");
  }

  const { maintenanceCycleId, dueDate } = await ensureMaintenanceCollectionForBillingCycle(
    tx,
    params.billingCycleId,
  );
  await ensureVillaSnapshotForMaintenanceCycle(tx, {
    maintenanceCycleId,
    villaId: user.villaId,
    fallbackExpected: Number(billingCycle.amount),
    dueDate,
  });

  await applyVillaCreditAcrossSnapshots(tx, {
    societyId: params.societyId,
    villaId: user.villaId,
    financialYearId: billingCycle.financialYearId,
    throughCycleId: maintenanceCycleId,
  });

  const snap = await tx.villaMaintenanceSnapshot.findUnique({
    where: { cycleId_villaId: { cycleId: maintenanceCycleId, villaId: user.villaId } },
    select: { paidAmount: true, status: true },
  });
  const paidAmount = Number(snap?.paidAmount ?? 0);
  const snapStatus = snap?.status ?? "PENDING";
  const source = params.source ?? BillingPaymentSource.GATEWAY;

  await syncBillingUserCyclePaymentsFromSnapshot(tx, {
    societyId: params.societyId,
    villaId: user.villaId,
    billingCycleId: params.billingCycleId,
    paidAmount,
    snapStatus,
    source,
    cashPaidAmount: 0,
  });

  return { snapStatus, paidAmount };
}

/**
 * When `user_payments` shows SUCCESS but maintenance snapshots still read unpaid,
 * backfill MaintenancePayment rows from the billing ledger.
 */
export async function reconcileVillaLedgerFromUserCyclePayment(
  tx: Prisma.TransactionClient,
  params: {
    societyId: string;
    villaId: string;
    billingCycleId: string;
    note?: string;
  },
): Promise<boolean> {
  const billingCycle = await tx.billingCycle.findFirst({
    where: { id: params.billingCycleId, societyId: params.societyId },
    select: { id: true, financialYearId: true, amount: true, paymentEndDate: true },
  });
  if (!billingCycle?.financialYearId) return false;

  const ucp = await tx.userCyclePayment.findFirst({
    where: {
      cycleId: params.billingCycleId,
      paymentStatus: BillingUserPaymentStatus.SUCCESS,
      user: {
        societyId: params.societyId,
        villaId: params.villaId,
        isActive: true,
        maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
        ...residentLikeRoleFilter,
      },
    },
    orderBy: { amountPaid: "desc" },
    select: { amountPaid: true, paidAt: true },
  });
  if (!ucp) return false;

  const billingPaid = Number(ucp.amountPaid);
  if (billingPaid <= 0.005) return false;

  const { maintenanceCycleId, dueDate } = await ensureMaintenanceCollectionForBillingCycle(
    tx,
    params.billingCycleId,
  );
  await ensureVillaSnapshotForMaintenanceCycle(tx, {
    maintenanceCycleId,
    villaId: params.villaId,
    fallbackExpected: Number(billingCycle.amount),
    dueDate,
  });

  const snapBefore = await tx.villaMaintenanceSnapshot.findUnique({
    where: { cycleId_villaId: { cycleId: maintenanceCycleId, villaId: params.villaId } },
    select: { paidAmount: true, status: true },
  });
  if (snapBefore?.status === "PAID" || snapBefore?.status === "WAIVED") {
    await applyVillaCreditAcrossSnapshots(tx, {
      societyId: params.societyId,
      villaId: params.villaId,
      financialYearId: billingCycle.financialYearId,
      throughCycleId: maintenanceCycleId,
    });
    const snap = await tx.villaMaintenanceSnapshot.findUnique({
      where: { cycleId_villaId: { cycleId: maintenanceCycleId, villaId: params.villaId } },
      select: { paidAmount: true, status: true },
    });
    if (snap) {
      await syncBillingUserCyclePaymentsFromSnapshot(tx, {
        societyId: params.societyId,
        villaId: params.villaId,
        billingCycleId: params.billingCycleId,
        paidAmount: Number(snap.paidAmount),
        snapStatus: snap.status,
        source: BillingPaymentSource.GATEWAY,
        cashPaidAmount: billingPaid,
      });
    }
    return false;
  }

  const cashAgg = await tx.maintenancePayment.aggregate({
    where: {
      societyId: params.societyId,
      villaId: params.villaId,
      maintenanceCollectionCycleId: maintenanceCycleId,
    },
    _sum: { amount: true },
  });
  const cashRecorded = Number(cashAgg._sum.amount ?? 0);
  const gap = Math.round((billingPaid - cashRecorded) * 100) / 100;

  if (gap > 0.005) {
    await postMarkCashToMaintenanceLedger(tx, {
      societyId: params.societyId,
      villaId: params.villaId,
      billingCycleId: params.billingCycleId,
      cashAmount: gap,
      paidAt: ucp.paidAt ?? new Date(),
      note: params.note ?? "Reconcile billing payment → maintenance ledger",
    });
    return true;
  }

  await applyVillaCreditAcrossSnapshots(tx, {
    societyId: params.societyId,
    villaId: params.villaId,
    financialYearId: billingCycle.financialYearId,
    throughCycleId: maintenanceCycleId,
  });

  const snap = await tx.villaMaintenanceSnapshot.findUnique({
    where: { cycleId_villaId: { cycleId: maintenanceCycleId, villaId: params.villaId } },
    select: { paidAmount: true, status: true },
  });
  if (!snap) return false;

  await syncBillingUserCyclePaymentsFromSnapshot(tx, {
    societyId: params.societyId,
    villaId: params.villaId,
    billingCycleId: params.billingCycleId,
    paidAmount: Number(snap.paidAmount),
    snapStatus: snap.status,
    source: BillingPaymentSource.CASH_MANUAL,
  });

  return snap.status === "PAID" || Number(snap.paidAmount) > 0.005;
}

/**
 * Full villa alignment: billing `user_payments` → maintenance cash ledger → credit walker → billing rows.
 * Call after any maintenance/billing mutation that might touch only one ledger.
 */
export async function ensureVillaLedgersAligned(
  tx: Prisma.TransactionClient,
  params: {
    societyId: string;
    villaId: string;
    billingCycleId: string;
    note?: string;
    source?: BillingPaymentSource;
    /** Gateway cash on user_payments — preserved when syncing from snapshot total. */
    cashPaidAmount?: number;
  },
): Promise<void> {
  await reconcileVillaLedgerFromUserCyclePayment(tx, params);

  const billingCycle = await tx.billingCycle.findFirst({
    where: { id: params.billingCycleId, societyId: params.societyId },
    select: { financialYearId: true },
  });
  if (!billingCycle?.financialYearId) return;

  const { maintenanceCycleId } = await ensureMaintenanceCollectionForBillingCycle(
    tx,
    params.billingCycleId,
  );

  await applyVillaCreditAcrossSnapshots(tx, {
    societyId: params.societyId,
    villaId: params.villaId,
    financialYearId: billingCycle.financialYearId,
    throughCycleId: maintenanceCycleId,
  });

  const snap = await tx.villaMaintenanceSnapshot.findUnique({
    where: { cycleId_villaId: { cycleId: maintenanceCycleId, villaId: params.villaId } },
    select: { paidAmount: true, status: true },
  });
  if (!snap) return;

  await syncBillingUserCyclePaymentsFromSnapshot(tx, {
    societyId: params.societyId,
    villaId: params.villaId,
    billingCycleId: params.billingCycleId,
    paidAmount: Number(snap.paidAmount),
    snapStatus: snap.status,
    source: params.source ?? BillingPaymentSource.CASH_MANUAL,
    cashPaidAmount: params.cashPaidAmount,
  });
}

/** Repair every primary occupant villa for a billing cycle (admin sync / grid load). */
export async function reconcileAllVillasForBillingCycle(
  tx: Prisma.TransactionClient,
  params: { societyId: string; billingCycleId: string },
): Promise<number> {
  const primaryOccupants = await tx.user.findMany({
    where: {
      societyId: params.societyId,
      isActive: true,
      maintenanceBillingRole: MaintenanceBillingRole.PRIMARY,
      villaId: { not: null },
      ...residentLikeRoleFilter,
    },
    select: { villaId: true },
  });
  const villaIds = [
    ...new Set(
      primaryOccupants
        .map((u) => u.villaId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];

  let repaired = 0;
  for (const villaId of villaIds) {
    const changed = await reconcileVillaLedgerFromUserCyclePayment(tx, {
      societyId: params.societyId,
      villaId,
      billingCycleId: params.billingCycleId,
    });
    if (changed) repaired += 1;
    await ensureVillaLedgersAligned(tx, {
      societyId: params.societyId,
      villaId,
      billingCycleId: params.billingCycleId,
    });
  }

  const billingCycle = await tx.billingCycle.findFirst({
    where: { id: params.billingCycleId, societyId: params.societyId },
    select: { financialYearId: true, cycleKey: true },
  });
  if (billingCycle?.financialYearId) {
    const mcc = await tx.maintenanceCollectionCycle.findFirst({
      where: {
        societyId: params.societyId,
        financialYearId: billingCycle.financialYearId,
        periodKey: billingCycle.cycleKey,
      },
      select: { id: true, periodKey: true },
    });
    if (mcc) {
      await syncAllUserCyclePaymentsForMaintenanceCycle(tx, {
        societyId: params.societyId,
        maintenanceCycleId: mcc.id,
        financialYearId: billingCycle.financialYearId,
        periodKey: mcc.periodKey,
        source: BillingPaymentSource.CASH_MANUAL,
      });
    }
  }

  return repaired;
}
