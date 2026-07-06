import { BillingCycle } from "@prisma/client";

export type BillingCycleDueFields = Pick<
  BillingCycle,
  "paymentEndDate" | "gracePeriodDays"
> & {
  amount: unknown;
  lateFee: unknown;
};

export type AmountDueBreakdown = {
  baseAmount: number;
  lateFeeAmount: number;
  totalDue: number;
  lateFeeApplies: boolean;
};

export type CycleSnapshotLateFeeInput = {
  expectedAmount: unknown;
  lateFeeAmount?: unknown;
  lateFeeAppliedAt?: Date | null;
};

/**
 * Late fee applies after `(payment window end + grace)` when still unpaid.
 * Waiver flag removes late portion only (base stays due until paid).
 */
export function computeAmountDueForCycle(
  cycle: BillingCycleDueFields,
  nowUtc: Date,
  lateFeeWaived: boolean
): AmountDueBreakdown {
  const base = Number(cycle.amount);
  const late = Number(cycle.lateFee);
  const end = cycle.paymentEndDate.getTime();
  const graceMs = Math.max(0, cycle.gracePeriodDays) * 24 * 60 * 60 * 1000;
  const lateEligibleAt = end + graceMs;

  let lateFeeApplies = !lateFeeWaived && nowUtc.getTime() > lateEligibleAt;
  if (lateFeeWaived) {
    lateFeeApplies = false;
  }

  const lateFeeAmount = lateFeeApplies ? late : 0;
  return {
    baseAmount: base,
    lateFeeAmount,
    totalDue: base + lateFeeAmount,
    lateFeeApplies,
  };
}

/** Base maintenance for a cycle — snapshot override when present, else billing-cycle amount. */
export function resolvePerCycleBaseAmount(
  cycle: Pick<BillingCycleDueFields, "amount">,
  snapshot: CycleSnapshotLateFeeInput | null | undefined,
): number {
  return snapshot ? Number(snapshot.expectedAmount) : Number(cycle.amount);
}

/**
 * Late fee for one billing cycle only.
 * Cron-applied snapshot late fee wins when present; otherwise use that cycle's billing late-fee rules.
 */
export function resolvePerCycleLateFee(
  cycle: BillingCycleDueFields,
  snapshot: CycleSnapshotLateFeeInput | null | undefined,
  nowUtc: Date,
  lateFeeWaived: boolean,
): number {
  const snapLate = snapshot ? Number(snapshot.lateFeeAmount ?? 0) : 0;
  if (snapLate > 0 || snapshot?.lateFeeAppliedAt) {
    return snapLate;
  }
  return computeAmountDueForCycle(cycle, nowUtc, lateFeeWaived).lateFeeAmount;
}

/** Per-cycle expected total (base + late) — each cycle evaluated independently. */
export function resolvePerCycleExpectedTotal(
  cycle: BillingCycleDueFields,
  snapshot: CycleSnapshotLateFeeInput | null | undefined,
  nowUtc: Date,
  lateFeeWaived: boolean,
): { baseAmount: number; lateFeeAmount: number; totalExpected: number } {
  const baseAmount = resolvePerCycleBaseAmount(cycle, snapshot);
  const lateFeeAmount = resolvePerCycleLateFee(cycle, snapshot, nowUtc, lateFeeWaived);
  return { baseAmount, lateFeeAmount, totalExpected: baseAmount + lateFeeAmount };
}

export type LedgerSnapshotInput = CycleSnapshotLateFeeInput & {
  paidAmount?: unknown;
  status?: string;
};

/**
 * Expected due for one cycle when a maintenance snapshot exists.
 * Does not retroactively add billing-cycle late fee after base maintenance is already paid.
 */
export function resolveLedgerCycleExpected(
  cycle: BillingCycleDueFields,
  snapshot: LedgerSnapshotInput | null | undefined,
  nowUtc: Date,
  lateFeeWaived: boolean,
): { baseAmount: number; lateFeeAmount: number; totalExpected: number } {
  if (!snapshot) {
    return resolvePerCycleExpectedTotal(cycle, null, nowUtc, lateFeeWaived);
  }

  const snapBase = Number(snapshot.expectedAmount);
  const snapLate = Number(snapshot.lateFeeAmount ?? 0);
  const snapPaid = Number(snapshot.paidAmount ?? 0);

  if (snapshot.status === "PAID" || snapshot.status === "WAIVED") {
    return {
      baseAmount: snapBase,
      lateFeeAmount: snapLate,
      totalExpected: snapBase + snapLate,
    };
  }

  if (snapLate > 0 || snapshot.lateFeeAppliedAt) {
    return {
      baseAmount: snapBase,
      lateFeeAmount: snapLate,
      totalExpected: snapBase + snapLate,
    };
  }

  // Base already settled — never add billing-cycle late fee on top retroactively.
  if (snapPaid >= snapBase - 0.005) {
    return { baseAmount: snapBase, lateFeeAmount: 0, totalExpected: snapBase };
  }

  const billingLate = computeAmountDueForCycle(cycle, nowUtc, lateFeeWaived).lateFeeAmount;
  return {
    baseAmount: snapBase,
    lateFeeAmount: billingLate,
    totalExpected: snapBase + billingLate,
  };
}

/**
 * Total obligation for a cycle when walking advance credit.
 *
 * Mirrors [resolveLedgerCycleExpected]'s rules so the walker and the resident
 * ledger always agree on what a cycle owes:
 * - A cron/admin-recorded snapshot late fee is always part of the obligation
 *   (cash + advance credit can settle it and the pool zeroes correctly).
 * - A billing-cycle late fee is only *synthesized* (purely time-based) for
 *   cycles whose base is still unpaid. A cycle already settled on time must
 *   never grow a retroactive fee — that would flip PAID snapshots back to
 *   PARTIAL and silently drain the villa's credit pool.
 */
export function resolveCreditWalkCycleExpected(
  snap: LedgerSnapshotInput,
  billingCycle: BillingCycleDueFields | null | undefined,
  nowUtc: Date,
  lateFeeWaived = false,
): number {
  const snapBase = Number(snap.expectedAmount);
  const snapLate = Number(snap.lateFeeAmount ?? 0);
  if (snapLate > 0.005 || snap.lateFeeAppliedAt) {
    return snapBase + snapLate;
  }
  // Base already settled — never add a billing-cycle late fee retroactively
  // (same guard as resolveLedgerCycleExpected).
  const snapPaid = Number(snap.paidAmount ?? 0);
  if (snapPaid >= snapBase - 0.005) {
    return snapBase;
  }
  if (billingCycle) {
    return resolvePerCycleExpectedTotal(billingCycle, snap, nowUtc, lateFeeWaived).totalExpected;
  }
  return snapBase;
}
