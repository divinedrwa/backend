import { UserRole } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../../lib/prisma";
import {
  localDateKey,
  localDateKeysForLastDays,
  localHour,
  startOfLocalCalendarDay,
  startOfLocalDayDaysAgo,
} from "../../lib/societyTime";
import { requireAuth, requireRole } from "../../middlewares/auth";
import {
  longestGapMinutes,
  supplyIntervals,
  supplyMinutesByDay,
  type SupplyInterval,
} from "./supplyIntervals";
import { isWaterTurnedOff, isWaterTurnedOn } from "./waterEventAction";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN, UserRole.GUARD));

/** "Last N days" including today. */
function periodDays(raw: unknown, fallback: number): number {
  return Math.min(Math.max(parseInt(String(raw ?? "")) || fallback, 1), 365);
}

/** Supply intervals per gate for the last N local days (incl. today). */
async function loadSupply(societyId: string, days: number) {
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
      return { gate, events, last, intervals: supplyIntervals(events, from, to, before) };
    }),
  );
  // Days before the first ever ON/OFF tap are "not tracked", not "no water".
  const first = await prisma.waterSupplyEvent.findFirst({
    where: { societyId },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const trackedFrom = first && first.createdAt > from ? first.createdAt : from;
  const trackedDays = Math.min(
    days,
    Math.max(
      1,
      Math.round((startOfLocalCalendarDay(to).getTime() - startOfLocalCalendarDay(trackedFrom).getTime()) / 86_400_000) + 1,
    ),
  );
  return { from, to, perGate, trackedFrom, trackedDays };
}

const minutesOf = (ivs: SupplyInterval[]) =>
  ivs.reduce((s, iv) => s + (iv.end.getTime() - iv.start.getTime()) / 60000, 0);

const formatHour = (hour: number) => {
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${displayHour}:00 ${period}`;
};

// GET /api/water-supply-analytics/overview — supply time, outages and current status.
router.get("/overview", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const daysAgo = periodDays(req.query.days, 7);
    const { from, to, perGate, trackedFrom, trackedDays } = await loadSupply(societyId, daysAgo);

    const events = perGate.flatMap((g) => g.events);
    const intervals = perGate.flatMap((g) => g.intervals);
    const completed = intervals.filter((iv) => !iv.ongoing);
    const supplyMinutes = Math.round(minutesOf(intervals));
    const longestRun = intervals.length
      ? Math.round(Math.max(...intervals.map((iv) => (iv.end.getTime() - iv.start.getTime()) / 60000)))
      : 0;

    return res.json({
      period: { days: daysAgo, startDate: from, endDate: to, trackedFrom, trackedDays },
      summary: {
        totalEvents: events.length,
        onEvents: events.filter((e) => isWaterTurnedOn(e)).length,
        offEvents: events.filter((e) => isWaterTurnedOff(e)).length,
        /** Average length of one supply (ON→OFF). */
        avgDurationMinutes: completed.length ? Math.round(minutesOf(completed) / completed.length) : 0,
        completedCycles: completed.length,
        supplyMinutes,
        /** Per tracked day: days before the first ever ON/OFF tap don't count. */
        avgSupplyMinutesPerDay: Math.round(supplyMinutes / trackedDays),
        longestSupplyMinutes: longestRun,
        /** Longest stretch without water since tracking began; null when no supply was logged. */
        longestGapMinutes: intervals.length ? longestGapMinutes(intervals, trackedFrom, to) : null,
        runningNow: perGate.filter((g) => g.last && isWaterTurnedOn(g.last)).length,
      },
      gateStats: perGate
        .filter((g) => g.events.length > 0)
        .map((g) => ({
          gateId: g.gate.id,
          gateName: g.gate.name,
          onCount: g.events.filter((e) => isWaterTurnedOn(e)).length,
          offCount: g.events.filter((e) => isWaterTurnedOff(e)).length,
          totalEvents: g.events.length,
          supplyMinutes: Math.round(minutesOf(g.intervals)),
        })),
      currentStatus: perGate.map((g) => ({
        gateId: g.gate.id,
        gateName: g.gate.name,
        currentStatus: g.last ? (isWaterTurnedOn(g.last) ? "ON" : "OFF") : "UNKNOWN",
        lastUpdated: g.last?.createdAt ?? null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/water-supply-analytics/daily-usage — hours of supply per local day.
router.get("/daily-usage", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const daysCount = periodDays(req.query.days, 7);
    const { perGate } = await loadSupply(societyId, daysCount);

    const minutesByDay = supplyMinutesByDay(perGate.flatMap((g) => g.intervals));
    const counts = new Map<string, { on: number; off: number }>();
    for (const e of perGate.flatMap((g) => g.events)) {
      const key = localDateKey(e.createdAt);
      const slot = counts.get(key) ?? { on: 0, off: 0 };
      if (isWaterTurnedOn(e)) slot.on++;
      if (isWaterTurnedOff(e)) slot.off++;
      counts.set(key, slot);
    }

    const usageData = localDateKeysForLastDays(daysCount).map((date) => {
      const c = counts.get(date) ?? { on: 0, off: 0 };
      const minutes = Math.round(minutesByDay.get(date) ?? 0);
      return {
        date,
        displayDate: new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
        onCount: c.on,
        offCount: c.off,
        totalEvents: c.on + c.off,
        supplyMinutes: minutes,
        supplyHours: Math.round((minutes / 60) * 10) / 10,
      };
    });

    return res.json({ usageData });
  } catch (error) {
    next(error);
  }
});

// GET /api/water-supply-analytics/hourly-pattern
// Get hourly pattern of water supply events
router.get("/hourly-pattern", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const daysAgo = periodDays(req.query.days, 30);
    const startDate = startOfLocalDayDaysAgo(daysAgo - 1);

    const events = await prisma.waterSupplyEvent.findMany({
      where: { societyId, createdAt: { gte: startDate } },
      select: { createdAt: true, action: true, turnedOn: true },
    });

    const hourlyData: { [hour: number]: { on: number; off: number } } = {};
    for (let i = 0; i < 24; i++) {
      hourlyData[i] = { on: 0, off: 0 };
    }

    events.forEach((e) => {
      const hour = localHour(new Date(e.createdAt));
      if (isWaterTurnedOn(e)) hourlyData[hour].on++;
      if (isWaterTurnedOff(e)) hourlyData[hour].off++;
    });

    const pattern = Object.entries(hourlyData).map(([hour, data]) => ({
      hour: parseInt(hour),
      label: formatHour(parseInt(hour)),
      onCount: data.on,
      offCount: data.off,
      totalEvents: data.on + data.off,
    }));

    const peakHours = [...pattern]
      .filter((p) => p.totalEvents > 0)
      .sort((a, b) => b.totalEvents - a.totalEvents)
      .slice(0, 3)
      .map((p) => ({
        hour: p.hour,
        label: p.label,
        totalEvents: p.totalEvents,
        onCount: p.onCount,
        offCount: p.offCount,
      }));

    return res.json({ pattern, peakHours });
  } catch (error) {
    next(error);
  }
});

// GET /api/water-supply-analytics/recent-events
// Get recent water supply events
router.get("/recent-events", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "")) || 20, 1), 200);

    const events = await prisma.waterSupplyEvent.findMany({
      where: { societyId },
      include: { gate: { select: { name: true, location: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const recentEvents = events.map((e) => ({
      id: e.id,
      action: isWaterTurnedOn(e) ? "ON" : "OFF",
      turnedOn: e.turnedOn,
      timestamp: e.createdAt,
      reason: e.reason,
      gate: e.gate ? { name: e.gate.name, location: e.gate.location } : null,
      minutesAgo: Math.floor((Date.now() - new Date(e.createdAt).getTime()) / (1000 * 60)),
    }));

    return res.json({ recentEvents });
  } catch (error) {
    next(error);
  }
});

// GET /api/water-supply-analytics/gate-performance — per-gate supply time and status.
router.get("/gate-performance", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const daysAgo = periodDays(req.query.days, 30);
    const { perGate } = await loadSupply(societyId, daysAgo);

    const gatePerformance = perGate.map((g) => {
      const completed = g.intervals.filter((iv) => !iv.ongoing);
      return {
        gateId: g.gate.id,
        gateName: g.gate.name,
        location: g.gate.location,
        totalEvents: g.events.length,
        onEvents: g.events.filter((e) => isWaterTurnedOn(e)).length,
        offEvents: g.events.filter((e) => isWaterTurnedOff(e)).length,
        avgDurationMinutes: completed.length ? Math.round(minutesOf(completed) / completed.length) : 0,
        completedCycles: completed.length,
        supplyMinutes: Math.round(minutesOf(g.intervals)),
        // Status is the gate's latest event ever, not just within the period.
        currentStatus: g.last ? (isWaterTurnedOn(g.last) ? "ON" : "OFF") : "UNKNOWN",
        lastEventTime: g.last?.createdAt ?? null,
      };
    });

    return res.json({ gatePerformance });
  } catch (error) {
    next(error);
  }
});

export default router;
