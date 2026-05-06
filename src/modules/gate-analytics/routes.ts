import { UserRole } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../../lib/prisma";
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
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const visitorCounts = await Promise.all(
      gates.map(async (gate) => {
        const count = await prisma.visitor.count({
          where: {
            societyId,
            gateId: gate.id,
            checkInAt: {
              gte: startOfDay,
            },
          },
        });

        const activeCount = await prisma.visitor.count({
          where: {
            societyId,
            gateId: gate.id,
            checkInAt: {
              gte: startOfDay,
            },
            checkOutAt: null,
          },
        });

        return {
          gateId: gate.id,
          gateName: gate.name,
          todayTotal: count,
          activeNow: activeCount,
        };
      })
    );

    const gateOverview = gates.map((gate) => {
      const stats = visitorCounts.find((v) => v.gateId === gate.id);
      return {
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
        todayVisitors: stats?.todayTotal || 0,
        activeVisitors: stats?.activeNow || 0,
      };
    });

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

    const daysAgo = parseInt(days as string) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysAgo);
    startDate.setHours(0, 0, 0, 0);

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

    const daysAgo = parseInt(days as string) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysAgo);

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
      const hour = new Date(v.checkInAt).getHours();
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

    const daysCount = parseInt(days as string) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysCount);
    startDate.setHours(0, 0, 0, 0);

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

    for (let i = 0; i < daysCount; i++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + i);
      const dateKey = date.toISOString().split("T")[0];
      dailyData[dateKey] = { total: 0, types: {} };
    }

    visitors.forEach((v) => {
      const dateKey = new Date(v.checkInAt).toISOString().split("T")[0];
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
