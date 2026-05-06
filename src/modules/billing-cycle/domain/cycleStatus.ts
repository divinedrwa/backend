import { BillingCycleStatus } from "@prisma/client";

/**
 * Canonical cycle lifecycle (UTC comparison). Deadline is inclusive for OPEN (`now <= paymentEndDate`).
 */
export function deriveCycleStatusUtc(
  nowUtc: Date,
  paymentStartDateUtc: Date,
  paymentEndDateUtc: Date
): BillingCycleStatus {
  const n = nowUtc.getTime();
  const s = paymentStartDateUtc.getTime();
  const e = paymentEndDateUtc.getTime();
  if (n < s) return BillingCycleStatus.UPCOMING;
  if (n <= e) return BillingCycleStatus.OPEN;
  return BillingCycleStatus.CLOSED;
}
