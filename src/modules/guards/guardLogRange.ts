/** Shared date-range parsing for guard log APIs (`from` / `to` query params). */

import {
  endOfLocalCalendarDay,
  localDayRange,
  parseLocalDateKey,
  startOfLocalCalendarDay,
} from "../../lib/societyTime";

export type GuardLogRangeOk = { ok: true; start: Date; endInclusive: Date };
export type GuardLogRangeErr = { ok: false; message: string };
export type GuardLogRangeResult = GuardLogRangeOk | GuardLogRangeErr;

const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

function parseQueryDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    try {
      return parseLocalDateKey(trimmed);
    } catch {
      return null;
    }
  }
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * No `from`/`to`: today's window [society-local midnight, society-local end of day].
 * Both `from` and `to`: inclusive range per IST calendar day.
 */
export function resolveGuardLogRange(query: Record<string, unknown>): GuardLogRangeResult {
  const fromRaw = query.from;
  const toRaw = query.to;
  const fromStr = typeof fromRaw === "string" ? fromRaw.trim() : "";
  const toStr = typeof toRaw === "string" ? toRaw.trim() : "";

  if (!fromStr && !toStr) {
    const { start, end } = localDayRange();
    return { ok: true, start, endInclusive: end };
  }

  if (!fromStr || !toStr) {
    return { ok: false, message: "Both from and to are required for a custom date range" };
  }

  const startParse = parseQueryDate(fromStr);
  const endParse = parseQueryDate(toStr);
  if (!startParse || !endParse) {
    return { ok: false, message: "Invalid from or to date (use ISO date or datetime)" };
  }

  const rangeStart = startOfLocalCalendarDay(startParse);
  const rangeEnd = endOfLocalCalendarDay(endParse);

  if (rangeStart.getTime() > rangeEnd.getTime()) {
    return { ok: false, message: "from must be on or before to" };
  }

  if (rangeEnd.getTime() - rangeStart.getTime() > MAX_RANGE_MS) {
    return { ok: false, message: "Date range cannot exceed 90 days" };
  }

  return { ok: true, start: rangeStart, endInclusive: rangeEnd };
}

/** Whether [now] falls within [start, end] inclusive. */
export function isNowWithinShift(start: Date, end: Date, now = new Date()): boolean {
  return now.getTime() >= start.getTime() && now.getTime() <= end.getTime();
}
