import { BillingCycleStatus } from "@prisma/client";
import {
  endOfLocalCalendarDay,
  localDateKey,
  societyTimeZone,
  startOfLocalCalendarDay,
} from "../../../lib/societyTime";

/**
 * Cycle lifecycle using society-local calendar dates (default Asia/Kolkata).
 * Payment window Aug 1–10 means those whole local days — not UTC instants.
 * Deadline is inclusive for OPEN (`now` local date <= end local date).
 */
export function deriveCycleStatus(
  nowUtc: Date,
  paymentStartDate: Date,
  paymentEndDate: Date,
  timeZone = societyTimeZone(),
): BillingCycleStatus {
  const nowKey = localDateKey(nowUtc, timeZone);
  const startKey = localDateKey(paymentStartDate, timeZone);
  const endKey = localDateKey(paymentEndDate, timeZone);
  if (nowKey < startKey) return BillingCycleStatus.UPCOMING;
  if (nowKey <= endKey) return BillingCycleStatus.OPEN;
  return BillingCycleStatus.CLOSED;
}

/** @deprecated Use deriveCycleStatus — kept for existing imports. */
export const deriveCycleStatusUtc = deriveCycleStatus;

/** Normalize admin-selected payment bounds to full local calendar days. */
export function normalizeBillingPaymentWindow(
  paymentStartDate: Date,
  paymentEndDate: Date,
  timeZone = societyTimeZone(),
): { paymentStartDate: Date; paymentEndDate: Date } {
  return {
    paymentStartDate: startOfLocalCalendarDay(paymentStartDate, timeZone),
    paymentEndDate: endOfLocalCalendarDay(paymentEndDate, timeZone),
  };
}

/** Mobile/resident pickers: published cycles whose payment window has opened or closed. */
export function isAppVisibleBillingCycle(
  nowUtc: Date,
  cycle: {
    publishedAt?: Date | null;
    paymentStartDate: Date;
    paymentEndDate: Date;
  },
  timeZone = societyTimeZone(),
): boolean {
  if (!cycle.publishedAt) return false;
  const status = deriveCycleStatus(
    nowUtc,
    cycle.paymentStartDate,
    cycle.paymentEndDate,
    timeZone,
  );
  return status === BillingCycleStatus.OPEN || status === BillingCycleStatus.CLOSED;
}
