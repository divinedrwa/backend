import { UserRole } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../../lib/prisma";
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

// GET /api/gate-analytics/overview
// Get overall gate status and statistics
router.get("/overview", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    // Get all gates with assigned guards
    const gates = await prisma.gate.findMany({
      where: { societyId },
      include: {
        assignedGuard: {
          select: {
            name: true,
            username: true,
            phone: true,
            isActive: true,
          },
        },
      },
      orderBy: { name: "asc" },
    });

    // Get today's visitor count per gate
    const startOfDay = startOfLocalDayDaysAgo(0);

    // Use groupBy to get all gate counts in 2 queries instead of 2N
    const [totalByGate, activeByGate] = await Promise.all([
      prisma.visitor.groupBy({
        by: ["gateId"],
        where: { societyId, checkInAt: { gte: startOfDay } },
        _count: true,
      }),
      prisma.visitor.groupBy({
        by: ["gateId"],
        where: { societyId, checkInAt: { gte: startOfDay }, checkOutAt: null },
        _count: true,
      }),
    ]);

    const totalMap = new Map(totalByGate.map((r) => [r.gateId, r._count]));
    const activeMap = new Map(activeByGate.map((r) => [r.gateId, r._count]));

    const gateOverview = gates.map((gate) => ({
      id: gate.id,
      name: gate.name,
      location: gate.location,
      isActive: gate.isActive,
      assignedGuard: gate.assignedGuard
        ? {
            name: gate.assignedGuard.name,
            username: gate.assignedGuard.username,
            phone: gate.assignedGuard.phone,
            isActive: gate.assignedGuard.isActive,
          }
        : null,
      todayVisitors: totalMap.get(gate.id) || 0,
      activeVisitors: activeMap.get(gate.id) || 0,
    }));

    return res.json({ gates: gateOverview });
  } catch (error) {
    next(error);
  }
});

// GET /api/gate-analytics/visitor-statistics
// Get visitor statistics for a period
router.get("/visitor-statistics", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { days = "30" } = req.query;

    const daysAgo = Math.min(Math.max(parseInt(days as string) || 30, 1), 365);
    const startDate = startOfLocalDayDaysAgo(daysAgo);

    // Get all visitors in period
    const visitors = await prisma.visitor.findMany({
      where: {
        societyId,
        checkInAt: {
          gte: startDate,
        },
      },
      select: {
        id: true,
        visitorType: true,
        gateId: true,
        checkInAt: true,
        checkOutAt: true,
      },
    });

    // Total visitors
    const totalVisitors = visitors.length;

    // By type
    const typeBreakdown: { [key: string]: number } = {};
    visitors.forEach((v) => {
      const type = v.visitorType || "GUEST";
      typeBreakdown[type] = (typeBreakdown[type] || 0) + 1;
    });

    // By gate
    const gateBreakdown: { [key: string]: number } = {};
    visitors.forEach((v) => {
      if (v.gateId) {
        gateBreakdown[v.gateId] = (gateBreakdown[v.gateId] || 0) + 1;
      }
    });

    // Get gate names
    const gates = await prisma.gate.findMany({
      where: {
        societyId,
        id: { in: Object.keys(gateBreakdown) },
      },
      select: { id: true, name: true },
    });

    const gateStats = gates.map((gate) => ({
      gateId: gate.id,
      gateName: gate.name,
      count: gateBreakdown[gate.id] || 0,
      percentage: totalVisitors > 0 
        ? Math.round((gateBreakdown[gate.id] / totalVisitors) * 100) 
        : 0,
    }));

    // Average duration (for checked-out visitors)
    const completedVisits = visitors.filter((v) => v.checkOutAt);
    let avgDurationMinutes = 0;
    if (completedVisits.length > 0) {
      const totalDuration = completedVisits.reduce((sum, v) => {
        const duration =
          new Date(v.checkOutAt!).getTime() - new Date(v.checkInAt).getTime();
        return sum + duration;
      }, 0);
      avgDurationMinutes = Math.round(
        totalDuration / (completedVisits.length * 1000 * 60)
      );
    }

    return res.json({
      period: {
        days: daysAgo,
        startDate,
        endDate: new Date(),
      },
      totalVisitors,
      typeBreakdown,
      gateStats,
      avgDurationMinutes,
      completedVisits: completedVisits.length,
      activeVisits: totalVisitors - completedVisits.length,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/gate-analytics/peak-hours
// Get peak hour analysis
router.get("/peak-hours", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { days = "30" } = req.query;

    const daysAgo = Math.min(Math.max(parseInt(days as string) || 30, 1), 365);
    const startDate = startOfLocalDayDaysAgo(daysAgo);

    const visitors = await prisma.visitor.findMany({
      where: {
        societyId,
        checkInAt: {
          gte: startDate,
        },
      },
      select: {
        checkInAt: true,
      },
    });

    // Group by hour of day
    const hourCounts: { [hour: number]: number } = {};
    for (let i = 0; i < 24; i++) {
      hourCounts[i] = 0;
    }

    visitors.forEach((v) => {
      const hour = localHour(new Date(v.checkInAt));
      hourCounts[hour]++;
    });

    // Find peak hours (top 3)
    const hourArray = Object.entries(hourCounts).map(([hour, count]) => ({
      hour: parseInt(hour),
      count,
    }));
    hourArray.sort((a, b) => b.count - a.count);
    const peakHours = hourArray.slice(0, 3);

    // Format hour labels
    const formatHour = (hour: number) => {
      const period = hour >= 12 ? "PM" : "AM";
      const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      return `${displayHour}:00 ${period}`;
    };

    const peakHoursFormatted = peakHours.map((p) => ({
      hour: p.hour,
      label: formatHour(p.hour),
      count: p.count,
    }));

    // All hours data for chart
    const hourlyData = hourArray.map((h) => ({
      hour: h.hour,
      label: formatHour(h.hour),
      count: h.count,
    }));

    return res.json({
      peakHours: peakHoursFormatted,
      hourlyData,
      totalVisitors: visitors.length,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/gate-analytics/daily-trend
// Get daily visitor trend
router.get("/daily-trend", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { days = "7" } = req.query;

    const daysCount = Math.min(Math.max(parseInt(days as string) || 7, 1), 365);
    const startDate = startOfLocalDayDaysAgo(daysCount);

    const visitors = await prisma.visitor.findMany({
      where: {
        societyId,
        checkInAt: {
          gte: startDate,
        },
      },
      select: {
        checkInAt: true,
        visitorType: true,
      },
    });

    // Group by day
    const dailyData: { [date: string]: { total: number; types: { [type: string]: number } } } = {};

    for (const dateKey of localDateKeysForLastDays(daysCount)) {
      dailyData[dateKey] = { total: 0, types: {} };
    }

    visitors.forEach((v) => {
      const dateKey = localDateKey(new Date(v.checkInAt));
      if (dailyData[dateKey]) {
        dailyData[dateKey].total++;
        const type = v.visitorType || "GUEST";
        dailyData[dateKey].types[type] = (dailyData[dateKey].types[type] || 0) + 1;
      }
    });

    const trendData = Object.entries(dailyData).map(([date, data]) => ({
      date,
      displayDate: new Date(date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      total: data.total,
      types: data.types,
    }));

    return res.json({ trendData });
  } catch (error) {
    next(error);
  }
});

export default router;
