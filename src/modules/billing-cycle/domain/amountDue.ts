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
