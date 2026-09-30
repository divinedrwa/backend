import { localDateKey, startOfLocalCalendarDay } from "../../lib/societyTime";
import { isWaterTurnedOff, isWaterTurnedOn } from "./waterEventAction";

type WaterEvent = { createdAt: Date; action?: string | null; turnedOn?: boolean | null };

/** A period when water was running at one gate. */
export type SupplyInterval = { start: Date; end: Date; ongoing: boolean };

/** Longest single interval ever counted as supply (anything longer is a missed OFF tap). */
const MAX_SUPPLY_MS = 12 * 60 * 60 * 1000;

/**
 * ON→OFF intervals for one gate within [from, to]. [stateBefore] is the last event
 * before `from`, so supply already running when the period starts is counted.
 */
export function supplyIntervals(
  events: WaterEvent[],
  from: Date,
  to: Date,
  stateBefore: WaterEvent | null,
): SupplyInterval[] {
  const sorted = [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const out: SupplyInterval[] = [];
  let onSince: Date | null = stateBefore && isWaterTurnedOn(stateBefore) ? from : null;
  for (const e of sorted) {
    if (isWaterTurnedOn(e)) {
      if (!onSince) onSince = e.createdAt;
    } else if (isWaterTurnedOff(e) && onSince) {
      push(onSince, e.createdAt, false);
      onSince = null;
    }
  }
  if (onSince) push(onSince, to, true);
  return out;

  function push(start: Date, end: Date, ongoing: boolean) {
    const s = start < from ? from : start;
    const cappedEnd = new Date(Math.min(end.getTime(), s.getTime() + MAX_SUPPLY_MS, to.getTime()));
    if (cappedEnd > s) out.push({ start: s, end: cappedEnd, ongoing });
  }
}

/** Minutes of supply per local day ("YYYY-MM-DD"), splitting intervals at midnight. */
export function supplyMinutesByDay(intervals: SupplyInterval[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const iv of intervals) {
    let cursor = iv.start;
    while (cursor < iv.end) {
      const dayStart = startOfLocalCalendarDay(cursor);
      const nextDay = startOfLocalCalendarDay(new Date(dayStart.getTime() + 36 * 60 * 60 * 1000));
      const sliceEnd = iv.end < nextDay ? iv.end : nextDay;
      const key = localDateKey(cursor);
      byDay.set(key, (byDay.get(key) ?? 0) + (sliceEnd.getTime() - cursor.getTime()) / 60000);
      cursor = sliceEnd;
    }
  }
  return byDay;
}

/** Longest stretch without supply between intervals (merged across gates). */
export function longestGapMinutes(intervals: SupplyInterval[], from: Date, to: Date): number {
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  let longest = 0;
  let cursor = from;
  for (const iv of sorted) {
    if (iv.start > cursor) longest = Math.max(longest, iv.start.getTime() - cursor.getTime());
    if (iv.end > cursor) cursor = iv.end;
  }
  if (to > cursor) longest = Math.max(longest, to.getTime() - cursor.getTime());
  return Math.round(longest / 60000);
}
