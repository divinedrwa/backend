import { prisma } from "../../lib/prisma";
import { startOfLocalCalendarDay, startOfLocalDayDaysAgo } from "../../lib/societyTime";
import { supplyIntervals, type SupplyInterval } from "./supplyIntervals";

/** Supply intervals per gate for the last N local days (incl. today). */
export async function loadSupply(societyId: string, days: number) {
  const from = startOfLocalDayDaysAgo(days - 1);
  const to = new Date();
  const gates = await prisma.gate.findMany({
    where: { societyId },
    select: { id: true, name: true, location: true },
    orderBy: { name: "asc" },
  });
  const perGate = await Promise.all(
    gates.map(async (gate) => {
      const [events, before, last] = await Promise.all([
        prisma.waterSupplyEvent.findMany({
          where: { societyId, gateId: gate.id, createdAt: { gte: from } },
          orderBy: { createdAt: "asc" },
        }),
        prisma.waterSupplyEvent.findFirst({
          where: { societyId, gateId: gate.id, createdAt: { lt: from } },
          orderBy: { createdAt: "desc" },
        }),
        prisma.waterSupplyEvent.findFirst({
          where: { societyId, gateId: gate.id },
          orderBy: { createdAt: "desc" },
        }),
      ]);
      return { gate, events, before, last, intervals: supplyIntervals(events, from, to, before) };
    }),
  );
  const tracking = trackingWindow(
    perGate.flatMap((g) => [...(g.before ? [g.before.createdAt] : []), ...g.events.map((e) => e.createdAt)]),
    from,
    to,
  );
  const trackedDays = Math.min(
    days,
    Math.max(
      1,
      Math.round(
        (startOfLocalCalendarDay(to).getTime() - startOfLocalCalendarDay(tracking.trackedFrom).getTime()) / 86_400_000,
      ) + 1,
    ),
  );
  return { from, to, perGate, ...tracking, trackedDays };
}

/** Days with no ON/OFF taps at all mean guards weren't logging — not "no water". */
export const LOGGING_BREAK_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The part of [from, to] that was actually logged: it starts after the last
 * logging break (a gap of more than 3 days between taps). `stale` means the
 * guards have not logged anything for over 3 days, so today's state is unknown.
 */
export function trackingWindow(times: Date[], from: Date, to: Date) {
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  if (sorted.length === 0) {
    return { trackedFrom: from, tracked: false, stale: false, lastLoggedAt: null as Date | null };
  }
  let start = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.getTime() - sorted[i - 1]!.getTime() > LOGGING_BREAK_MS) start = sorted[i]!;
  }
  const last = sorted[sorted.length - 1]!;
  return {
    trackedFrom: start > from ? start : from,
    tracked: last >= from,
    stale: to.getTime() - last.getTime() > LOGGING_BREAK_MS,
    lastLoggedAt: last,
  };
}

export const minutesOf = (ivs: SupplyInterval[]) =>
  ivs.reduce((s, iv) => s + (iv.end.getTime() - iv.start.getTime()) / 60000, 0);
