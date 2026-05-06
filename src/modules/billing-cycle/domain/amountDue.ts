import { BillingCycle } from "@prisma/client";

export type AmountDueBreakdown = {
  baseAmount: number;
  lateFeeAmount: number;
  totalDue: number;
  lateFeeApplies: boolean;
};

/**
 * Late fee applies after `(payment window end + grace)` when still unpaid.
 * Waiver flag removes late portion only (base stays due until paid).
 */
export function computeAmountDueForCycle(
  cycle: Pick<BillingCycle, "amount" | "lateFee" | "paymentEndDate" | "gracePeriodDays">,
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
