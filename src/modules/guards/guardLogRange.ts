/** Shared date-range parsing for guard log APIs (`from` / `to` query params). */

export type GuardLogRangeOk = { ok: true; start: Date; endInclusive: Date };
export type GuardLogRangeErr = { ok: false; message: string };
export type GuardLogRangeResult = GuardLogRangeOk | GuardLogRangeErr;

const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/**
 * No `from`/`to`: today's window [local midnight, local end of day].
 * Both `from` and `to`: inclusive range per calendar day (server local TZ).
 */
export function resolveGuardLogRange(query: Record<string, unknown>): GuardLogRangeResult {
  const fromRaw = query.from;
  const toRaw = query.to;
  const fromStr = typeof fromRaw === "string" ? fromRaw.trim() : "";
  const toStr = typeof toRaw === "string" ? toRaw.trim() : "";

  if (!fromStr && !toStr) {
    const today = new Date();
    const start = startOfLocalDay(today);
    const end = endOfLocalDay(today);
    return { ok: true, start, endInclusive: end };
  }

  if (!fromStr || !toStr) {
    return { ok: false, message: "Both from and to are required for a custom date range" };
  }

  const start = new Date(fromStr);
  const endParse = new Date(toStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endParse.getTime())) {
    return { ok: false, message: "Invalid from or to date (use ISO date or datetime)" };
  }

  const rangeStart = startOfLocalDay(start);
  const rangeEnd = endOfLocalDay(endParse);

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
