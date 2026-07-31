/**
 * Banner schedule helpers — date-only admin picks must be inclusive through end of day.
 * Legacy rows may store endDate as UTC midnight of the last day; queries treat that as
 * "visible for the full calendar day" as well.
 */

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function endOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
  );
}

/** Normalize stored start to UTC start-of-day. */
export function normalizeBannerStartDate(date: Date): Date {
  return startOfUtcDay(date);
}

/** Normalize stored end to UTC end-of-day so "31 Jul" means through 23:59:59 UTC that day. */
export function normalizeBannerEndDate(date: Date): Date {
  return endOfUtcDay(date);
}

export function bannerStartDateIsActive(startDate: Date, now: Date): boolean {
  return startDate <= now;
}

/** Inclusive end: valid through the entire UTC calendar day of endDate. */
export function bannerEndDateIsActive(endDate: Date | null, now: Date): boolean {
  if (endDate == null) return true;
  return endOfUtcDay(endDate) >= now;
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

import type { Prisma } from "@prisma/client";

/** Prisma where fragment for banners still within their end window (inclusive last day). */
export function bannerEndDateStillActiveWhere(now: Date): Pick<Prisma.BannerWhereInput, "OR"> {
  const startOfToday = startOfUtcDay(now);
  const endOfToday = endOfUtcDay(now);
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
