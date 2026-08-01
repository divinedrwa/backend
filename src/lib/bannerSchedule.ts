/**
 * Banner schedule helpers — date-only admin picks are inclusive IST calendar days.
 * Legacy rows may store endDate as midnight UTC; normalization expands to full local day.
 */
import type { Prisma } from "@prisma/client";
import {
  endOfLocalCalendarDay,
  localDayRange,
  societyTimeZone,
  startOfLocalCalendarDay,
} from "./societyTime";

const TZ = societyTimeZone();

/** @deprecated Use startOfLocalCalendarDay — kept for tests migrating from UTC helpers. */
export function startOfUtcDay(d: Date): Date {
  return startOfLocalCalendarDay(d, TZ);
}

/** @deprecated Use endOfLocalCalendarDay — kept for tests migrating from UTC helpers. */
export function endOfUtcDay(d: Date): Date {
  return endOfLocalCalendarDay(d, TZ);
}

/** Normalize stored start to society-local start-of-day. */
export function normalizeBannerStartDate(date: Date, timeZone = TZ): Date {
  return startOfLocalCalendarDay(date, timeZone);
}

/** Normalize stored end to society-local end-of-day so "31 Jul" means through 23:59:59 IST. */
export function normalizeBannerEndDate(date: Date, timeZone = TZ): Date {
  return endOfLocalCalendarDay(date, timeZone);
}

export function bannerStartDateIsActive(startDate: Date, now: Date): boolean {
  return startDate <= now;
}

/** Inclusive end: valid through the entire society-local calendar day of endDate. */
export function bannerEndDateIsActive(endDate: Date | null, now: Date, timeZone = TZ): boolean {
  if (endDate == null) return true;
  return endOfLocalCalendarDay(endDate, timeZone) >= now;
}

export function bannerIsInActiveWindow(banner: {
  isActive: boolean;
  startDate: Date;
  endDate: Date | null;
}): boolean {
  const now = new Date();
  if (!banner.isActive) return false;
  if (!bannerStartDateIsActive(banner.startDate, now)) return false;
  if (!bannerEndDateIsActive(banner.endDate, now)) return false;
  return true;
}

/** Prisma where fragment for banners still within their end window (inclusive last day). */
export function bannerEndDateStillActiveWhere(
  now: Date,
  timeZone = TZ,
): Pick<Prisma.BannerWhereInput, "OR"> {
  const { start: startOfToday, end: endOfToday } = localDayRange(now, timeZone);
  return {
    OR: [
      { endDate: null },
      { endDate: { gte: now } },
      {
        AND: [{ endDate: { gte: startOfToday } }, { endDate: { lte: endOfToday } }],
      },
    ],
  };
}
