import { UserRole } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN, UserRole.GUARD));

// GET /api/water-supply-analytics/overview
// Get water supply overview and statistics
router.get("/overview", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { days = "7" } = req.query;

    const daysAgo = parseInt(days as string) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysAgo);
    startDate.setHours(0, 0, 0, 0);

    // Get all water supply events in period
    const events = await prisma.waterSupplyEvent.findMany({
      where: {
        societyId,
        createdAt: {
          gte: startDate,
        },
      },
      include: {
        gate: {
          select: {
            name: true,
            location: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Calculate statistics
    const totalEvents = events.length;
    const onEvents = events.filter((e) => e.action === "ON").length;
    const offEvents = events.filter((e) => e.action === "OFF").length;

    // Calculate average duration (time between ON and OFF)
    const durations: number[] = [];
    const onEventMap = new Map<string, Date>();

    events
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .forEach((event) => {
        const key = event.gateId || "general";
        if (event.action === "ON") {
          onEventMap.set(key, new Date(event.createdAt));
        } else if (event.action === "OFF" && onEventMap.has(key)) {
          const onTime = onEventMap.get(key)!;
          const offTime = new Date(event.createdAt);
          const durationMinutes = (offTime.getTime() - onTime.getTime()) / (1000 * 60);
          if (durationMinutes > 0 && durationMinutes < 1440) {
            // Valid duration (< 24 hours)
            durations.push(durationMinutes);
          }
          onEventMap.delete(key);
        }
      });

    const avgDurationMinutes =
      durations.length > 0
        ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
        : 0;

    // Group by gate
    const gateBreakdown: { [gateId: string]: { on: number; off: number; gateName: string } } = {};
    events.forEach((e) => {
      if (e.gateId) {
        if (!gateBreakdown[e.gateId]) {
          gateBreakdown[e.gateId] = {
            on: 0,
            off: 0,
            gateName: e.gate?.name || "Unknown",
          };
        }
        if (e.action === "ON") gateBreakdown[e.gateId].on++;
        if (e.action === "OFF") gateBreakdown[e.gateId].off++;
      }
    });

    const gateStats = Object.entries(gateBreakdown).map(([gateId, data]) => ({
      gateId,
      gateName: data.gateName,
      onCount: data.on,
      offCount: data.off,
      totalEvents: data.on + data.off,
    }));

    // Get current status (last event per gate)
    const gates = await prisma.gate.findMany({
      where: { societyId },
      select: { id: true, name: true },
    });

    const currentStatus = await Promise.all(
      gates.map(async (gate) => {
        const lastEvent = await prisma.waterSupplyEvent.findFirst({
          where: {
            societyId,
            gateId: gate.id,
          },
          orderBy: { createdAt: "desc" },
        });

        return {
          gateId: gate.id,
          gateName: gate.name,
          currentStatus: lastEvent?.action || "UNKNOWN",
          lastUpdated: lastEvent?.createdAt || null,
        };
      })
    );

    return res.json({
      period: {
        days: daysAgo,
        startDate,
        endDate: new Date(),
      },
      summary: {
        totalEvents,
        onEvents,
        offEvents,
        avgDurationMinutes,
        completedCycles: durations.length,
      },
      gateStats,
      currentStatus,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/water-supply-analytics/daily-usage
// Get daily water supply usage pattern
router.get("/daily-usage", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { days = "7" } = req.query;

    const daysCount = parseInt(days as string) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysCount);
    startDate.setHours(0, 0, 0, 0);

    const events = await prisma.waterSupplyEvent.findMany({
      where: {
        societyId,
        createdAt: {
          gte: startDate,
        },
      },
      select: {
        createdAt: true,
        action: true,
      },
    });

    // Group by day
    const dailyData: {
      [date: string]: { on: number; off: number };
    } = {};

    for (let i = 0; i < daysCount; i++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + i);
      const dateKey = date.toISOString().split("T")[0];
      dailyData[dateKey] = { on: 0, off: 0 };
    }

    events.forEach((e) => {
      const dateKey = new Date(e.createdAt).toISOString().split("T")[0];
      if (dailyData[dateKey]) {
        if (e.action === "ON") dailyData[dateKey].on++;
        if (e.action === "OFF") dailyData[dateKey].off++;
      }
    });

    const usageData = Object.entries(dailyData).map(([date, data]) => ({
      date,
      displayDate: new Date(date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      onCount: data.on,
      offCount: data.off,
      totalEvents: data.on + data.off,
    }));

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
    const { days = "30" } = req.query;

    const daysAgo = parseInt(days as string) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysAgo);

    const events = await prisma.waterSupplyEvent.findMany({
      where: {
        societyId,
        createdAt: {
          gte: startDate,
        },
      },
      select: {
        createdAt: true,
        action: true,
      },
    });

    // Group by hour
    const hourlyData: { [hour: number]: { on: number; off: number } } = {};
    for (let i = 0; i < 24; i++) {
      hourlyData[i] = { on: 0, off: 0 };
    }

    events.forEach((e) => {
      const hour = new Date(e.createdAt).getHours();
      if (e.action === "ON") hourlyData[hour].on++;
      if (e.action === "OFF") hourlyData[hour].off++;
    });

    const formatHour = (hour: number) => {
      const period = hour >= 12 ? "PM" : "AM";
      const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      return `${displayHour}:00 ${period}`;
    };

    const pattern = Object.entries(hourlyData).map(([hour, data]) => ({
      hour: parseInt(hour),
      label: formatHour(parseInt(hour)),
      onCount: data.on,
      offCount: data.off,
      totalEvents: data.on + data.off,
    }));

    // Find peak hours
    const sorted = [...pattern].sort((a, b) => b.totalEvents - a.totalEvents);
    const peakHours = sorted.slice(0, 3).map((p) => ({
      hour: p.hour,
      label: p.label,
      totalEvents: p.totalEvents,
      onCount: p.onCount,
      offCount: p.offCount,
    }));

    return res.json({
      pattern,
      peakHours,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/water-supply-analytics/recent-events
// Get recent water supply events
router.get("/recent-events", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { limit = "20" } = req.query;

    const events = await prisma.waterSupplyEvent.findMany({
      where: { societyId },
      include: {
        gate: {
          select: {
            name: true,
            location: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(parseInt(limit as string) || 50, 1), 200),
    });

    const recentEvents = events.map((e) => ({
      id: e.id,
      action: e.action,
      timestamp: e.createdAt,
      reason: e.reason,
      gate: e.gate
        ? {
            name: e.gate.name,
            location: e.gate.location,
          }
        : null,
      minutesAgo: Math.floor(
        (Date.now() - new Date(e.createdAt).getTime()) / (1000 * 60)
      ),
    }));

    return res.json({ recentEvents });
  } catch (error) {
    next(error);
  }
});

// GET /api/water-supply-analytics/gate-performance
// Get gate-wise water supply performance
router.get("/gate-performance", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { days = "30" } = req.query;

    const daysAgo = parseInt(days as string) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysAgo);

    const gates = await prisma.gate.findMany({
      where: { societyId },
      select: {
        id: true,
        name: true,
        location: true,
      },
    });

    const gatePerformance = await Promise.all(
      gates.map(async (gate) => {
        const events = await prisma.waterSupplyEvent.findMany({
          where: {
            gateId: gate.id,
            createdAt: {
              gte: startDate,
            },
          },
          orderBy: { createdAt: "asc" },
        });

        const onEvents = events.filter((e) => e.action === "ON").length;
        const offEvents = events.filter((e) => e.action === "OFF").length;

        // Calculate durations
        const durations: number[] = [];
        let lastOnTime: Date | null = null;

        events.forEach((event) => {
          if (event.action === "ON") {
            lastOnTime = new Date(event.createdAt);
          } else if (event.action === "OFF" && lastOnTime) {
            const duration =
              (new Date(event.createdAt).getTime() - lastOnTime.getTime()) /
              (1000 * 60);
            if (duration > 0 && duration < 1440) {
              durations.push(duration);
            }
            lastOnTime = null;
          }
        });

        const avgDuration =
          durations.length > 0
            ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
            : 0;

        // Get last event
        const lastEvent = events.length > 0 ? events[events.length - 1] : null;

        return {
          gateId: gate.id,
          gateName: gate.name,
          location: gate.location,
          totalEvents: events.length,
          onEvents,
          offEvents,
          avgDurationMinutes: avgDuration,
          completedCycles: durations.length,
          currentStatus: lastEvent?.action || "UNKNOWN",
          lastEventTime: lastEvent?.createdAt || null,
        };
      })
    );

    return res.json({ gatePerformance });
  } catch (error) {
    next(error);
  }
});

export default router;
