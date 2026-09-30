import { Prisma, UserRole, VisitorCheckpointType, VisitorStatus } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { findActiveGuardShiftAtGate } from "../../lib/guardShiftActive";
import { resolveGuardDutyPhone } from "../../lib/guardDutyPhone";
import {
  localDateKey,
  localDateKeysForLastDays,
  localHour,
  startOfLocalDayDaysAgo,
} from "../../lib/societyTime";
import { requireAuth, requireRole } from "../../middlewares/auth";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN, UserRole.GUARD));

/** "Last N days" including today: N local calendar days. */
function periodDays(raw: unknown, fallback: number): number {
  return Math.min(Math.max(parseInt(String(raw ?? "")) || fallback, 1), 365);
}
function periodStart(days: number): Date {
  return startOfLocalDayDaysAgo(days - 1);
}

/**
 * A visit where the person was actually let in (not a request that was rejected,
 * expired or closed before entry). Older rows lack `checkedInByGuardId`, so an
 * admit/override checkpoint or a pre-approval also counts.
 */
const ADMITTED: Prisma.VisitorWhereInput = {
  status: { in: [VisitorStatus.CHECKED_IN, VisitorStatus.CHECKED_OUT] },
  OR: [
    { checkedInByGuardId: { not: null } },
    { preApprovedId: { not: null } },
    {
      checkpoints: {
        some: {
          checkpointType: {
            in: [VisitorCheckpointType.ADMITTED, VisitorCheckpointType.EMERGENCY_OVERRIDE],
          },
        },
      },
    },
  ],
};

/** Inside right now: admitted and no exit yet (any day). */
const INSIDE_NOW: Prisma.VisitorWhereInput = {
  status: VisitorStatus.CHECKED_IN,
  checkOutAt: null,
  checkOutTime: null,
};

const formatHour = (hour: number) => {
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${displayHour}:00 ${period}`;
};

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

// GET /api/gate-analytics/overview — gates, guard on duty, today's entries and who is inside.
router.get("/overview", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const gates = await prisma.gate.findMany({
      where: { societyId },
      include: {
        assignedGuard: { select: { name: true, username: true, phone: true, isActive: true } },
      },
      orderBy: { name: "asc" },
    });

    const startOfDay = startOfLocalDayDaysAgo(0);
    const [entriesByGate, requestsByGate, insideByGate, waitingByGate] = await Promise.all([
      prisma.visitor.groupBy({
        by: ["gateId"],
        where: { societyId, checkInAt: { gte: startOfDay }, ...ADMITTED },
        _count: true,
      }),
      prisma.visitor.groupBy({
        by: ["gateId"],
        where: { societyId, createdAt: { gte: startOfDay } },
        _count: true,
      }),
      prisma.visitor.groupBy({
        by: ["gateId"],
        where: { societyId, ...INSIDE_NOW },
        _count: true,
      }),
      prisma.visitor.groupBy({
        by: ["gateId"],
        where: { societyId, status: VisitorStatus.PENDING_APPROVAL, checkOutAt: null },
        _count: true,
      }),
    ]);
    const toMap = (rows: { gateId: string | null; _count: number }[]) =>
      new Map(rows.map((r) => [r.gateId, r._count]));
    const entries = toMap(entriesByGate);
    const requests = toMap(requestsByGate);
    const inside = toMap(insideByGate);
    const waiting = toMap(waitingByGate);

    const gateOverview = await Promise.all(
      gates.map(async (gate) => {
        const activeShift = await findActiveGuardShiftAtGate(prisma, { societyId, gateId: gate.id });
        const onDutyGuard = activeShift?.guard ?? gate.assignedGuard;
        const dutyPhone = resolveGuardDutyPhone(activeShift, onDutyGuard);
        return {
          id: gate.id,
          name: gate.name,
          location: gate.location,
          isActive: gate.isActive,
          assignedGuard: onDutyGuard
            ? {
                name: onDutyGuard.name,
                username: onDutyGuard.username,
                phone: dutyPhone,
                isActive: onDutyGuard.isActive,
                onShift: Boolean(activeShift),
                shiftType: activeShift?.shiftType ?? null,
              }
            : null,
          /** People let in today. */
          todayVisitors: entries.get(gate.id) ?? 0,
          todayEntries: entries.get(gate.id) ?? 0,
          /** Every request logged today, including rejected/expired. */
          todayRequests: requests.get(gate.id) ?? 0,
          /** Inside right now (entered and not exited, any day). */
          activeVisitors: inside.get(gate.id) ?? 0,
          insideNow: inside.get(gate.id) ?? 0,
          waitingNow: waiting.get(gate.id) ?? 0,
        };
      }),
    );

    return res.json({
      gates: gateOverview,
      totals: {
        gates: gates.length,
        activeGates: gates.filter((g) => g.isActive).length,
        guardsOnShift: gateOverview.filter((g) => g.assignedGuard?.onShift).length,
        todayEntries: gateOverview.reduce((s, g) => s + g.todayEntries, 0),
        todayRequests: gateOverview.reduce((s, g) => s + g.todayRequests, 0),
        insideNow: gateOverview.reduce((s, g) => s + g.insideNow, 0),
        waitingNow: gateOverview.reduce((s, g) => s + g.waitingNow, 0),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/gate-analytics/visitor-statistics — outcomes, approvals and stay time for a period.
router.get("/visitor-statistics", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const daysAgo = periodDays(req.query.days, 30);
    const startDate = periodStart(daysAgo);

    const [requests, admittedIds, insideNow, overrides, villaResponses, gates] = await Promise.all([
      prisma.visitor.findMany({
        where: { societyId, createdAt: { gte: startDate } },
        select: {
          id: true,
          status: true,
          visitorType: true,
          gateId: true,
          checkInAt: true,
          checkOutAt: true,
          exitNotMarked: true,
          preApprovedId: true,
        },
      }),
      prisma.visitor.findMany({
        where: { societyId, createdAt: { gte: startDate }, ...ADMITTED },
        select: { id: true },
      }),
      prisma.visitor.count({ where: { societyId, ...INSIDE_NOW } }),
      prisma.visitorCheckpoint.count({
        where: {
          checkpointType: VisitorCheckpointType.EMERGENCY_OVERRIDE,
          timestamp: { gte: startDate },
          visitor: { societyId },
        },
      }),
      prisma.visitorVilla.findMany({
        where: { visitor: { societyId, createdAt: { gte: startDate } }, notifiedAt: { not: null } },
        select: { approvalStatus: true, notifiedAt: true, respondedAt: true },
      }),
      prisma.gate.findMany({ where: { societyId }, select: { id: true, name: true } }),
    ]);

    const admitted = new Set(admittedIds.map((r) => r.id));
    const entries = requests.filter((v) => admitted.has(v.id));
    const rejected = requests.filter((v) => v.status === VisitorStatus.DENIED).length;
    const expired = requests.filter((v) => v.status === VisitorStatus.CANCELLED).length;
    const waiting = requests.filter((v) => v.status === VisitorStatus.PENDING_APPROVAL).length;
    const leftWithoutEntering = requests.filter(
      (v) => v.status === VisitorStatus.CHECKED_OUT && !admitted.has(v.id),
    ).length;

    // Stay time only from real exits (auto-closed "exit not marked" visits are excluded).
    const realExits = entries.filter((v) => v.checkOutAt && !v.exitNotMarked);
    const stays = realExits
      .map((v) => (v.checkOutAt!.getTime() - v.checkInAt.getTime()) / 60000)
      .filter((m) => m >= 0 && m < 24 * 60);
    const closedEntries = entries.filter((v) => v.checkOutAt);
    const exitNotMarked = closedEntries.filter((v) => v.exitNotMarked).length;

    // Resident decisions on walk-in requests.
    const responded = villaResponses.filter((r) => r.respondedAt);
    const approvedByResidents = responded.filter((r) => r.approvalStatus === "APPROVED").length;
    const responseMinutes = responded
      .map((r) => (r.respondedAt!.getTime() - r.notifiedAt!.getTime()) / 60000)
      .filter((m) => m >= 0 && m < 24 * 60);

    const typeBreakdown: Record<string, number> = {};
    for (const v of entries) {
      const type = v.visitorType || "GUEST";
      typeBreakdown[type] = (typeBreakdown[type] ?? 0) + 1;
    }
    const byGate = new Map<string, number>();
    for (const v of entries) if (v.gateId) byGate.set(v.gateId, (byGate.get(v.gateId) ?? 0) + 1);
    const gateStats = gates
      .filter((g) => byGate.has(g.id))
      .map((g) => ({
        gateId: g.id,
        gateName: g.name,
        count: byGate.get(g.id) ?? 0,
        percentage: pct(byGate.get(g.id) ?? 0, entries.length),
      }));

    const avgStay = stays.length ? Math.round(stays.reduce((s, m) => s + m, 0) / stays.length) : 0;

    return res.json({
      period: { days: daysAgo, startDate, endDate: new Date() },
      // Compatible fields, now meaning people actually let in.
      totalVisitors: entries.length,
      typeBreakdown,
      gateStats,
      avgDurationMinutes: avgStay,
      completedVisits: realExits.length,
      activeVisits: insideNow,
      outcomes: {
        requests: requests.length,
        entries: entries.length,
        preApprovedEntries: entries.filter((v) => v.preApprovedId).length,
        rejected,
        expired,
        waiting,
        leftWithoutEntering,
        insideNow,
      },
      approvals: {
        asked: villaResponses.length,
        answered: responded.length,
        approved: approvedByResidents,
        rejected: responded.length - approvedByResidents,
        approvalRatePct: pct(approvedByResidents, responded.length),
        answeredInAppPct: pct(responded.length, villaResponses.length),
        noReplyPct: pct(villaResponses.length - responded.length, villaResponses.length),
        medianResponseMinutes: median(responseMinutes),
        guardOverrides: overrides,
      },
      stay: {
        avgMinutes: avgStay,
        medianMinutes: median(stays),
        exitNotMarked,
        exitNotMarkedPct: pct(exitNotMarked, closedEntries.length),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/gate-analytics/peak-hours — busiest hours for people let in (local time).
router.get("/peak-hours", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const daysAgo = periodDays(req.query.days, 30);
    const startDate = periodStart(daysAgo);

    const visitors = await prisma.visitor.findMany({
      where: { societyId, checkInAt: { gte: startDate }, ...ADMITTED },
      select: { checkInAt: true },
    });

    const hourCounts = Array.from({ length: 24 }, () => 0);
    for (const v of visitors) hourCounts[localHour(new Date(v.checkInAt))]!++;

    const hourlyData = hourCounts.map((count, hour) => ({ hour, label: formatHour(hour), count }));
    const peakHours = [...hourlyData]
      .filter((h) => h.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    return res.json({ peakHours, hourlyData, totalVisitors: visitors.length });
  } catch (error) {
    next(error);
  }
});

// GET /api/gate-analytics/daily-trend — entries, requests and rejections per local day.
router.get("/daily-trend", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const daysCount = periodDays(req.query.days, 7);
    const startDate = periodStart(daysCount);

    const [requests, admittedIds] = await Promise.all([
      prisma.visitor.findMany({
        where: { societyId, createdAt: { gte: startDate } },
        select: { id: true, createdAt: true, checkInAt: true, visitorType: true, status: true },
      }),
      prisma.visitor.findMany({
        where: { societyId, createdAt: { gte: startDate }, ...ADMITTED },
        select: { id: true },
      }),
    ]);
    const admitted = new Set(admittedIds.map((r) => r.id));

    const daily = new Map<
      string,
      { total: number; requests: number; rejected: number; types: Record<string, number> }
    >();
    for (const key of localDateKeysForLastDays(daysCount)) {
      daily.set(key, { total: 0, requests: 0, rejected: 0, types: {} });
    }
    for (const v of requests) {
      const slot = daily.get(localDateKey(v.createdAt));
      if (!slot) continue;
      slot.requests++;
      if (v.status === VisitorStatus.DENIED) slot.rejected++;
      if (admitted.has(v.id)) {
        slot.total++;
        const type = v.visitorType || "GUEST";
        slot.types[type] = (slot.types[type] ?? 0) + 1;
      }
    }

    const trendData = [...daily.entries()].map(([date, d]) => ({
      date,
      displayDate: new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
      /** People let in. */
      total: d.total,
      entries: d.total,
      requests: d.requests,
      rejected: d.rejected,
      types: d.types,
    }));

    return res.json({ trendData });
  } catch (error) {
    next(error);
  }
});

export default router;
