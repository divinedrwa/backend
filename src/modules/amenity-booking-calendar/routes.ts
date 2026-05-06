import { UserRole } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

// GET /api/amenity-booking-calendar/overview
// Get calendar overview with all bookings
router.get("/overview", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { startDate, endDate } = req.query;

    const start = startDate ? new Date(startDate as string) : new Date();
    const end = endDate
      ? new Date(endDate as string)
      : new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const bookings = await prisma.amenityBooking.findMany({
      where: {
        societyId,
        startTime: {
          gte: start,
          lte: end,
        },
      },
      include: {
        amenity: {
          select: {
            name: true,
            type: true,
          },
        },
      },
      orderBy: { startTime: "asc" },
    });

    // Get resident/villa info
    const residentIds = [...new Set(bookings.map((b) => b.residentId))];
    const residents = await prisma.user.findMany({
      where: {
        id: { in: residentIds },
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
            block: true,
            ownerName: true,
          },
        },
      },
    });

    const residentMap = new Map(residents.map((r) => [r.id, r]));

    // Group by amenity
    const byAmenity: { [amenityId: string]: any[] } = {};
    bookings.forEach((b) => {
      if (!byAmenity[b.amenityId]) byAmenity[b.amenityId] = [];
      byAmenity[b.amenityId].push(b);
    });

    // Group by date
    const byDate: { [date: string]: any[] } = {};
    bookings.forEach((b) => {
      const dateKey = new Date(b.startTime).toISOString().split("T")[0];
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push(b);
    });

    // Count by status
    const totalBookings = bookings.length;
    const activeBookings = bookings.filter((b) => b.status === "CONFIRMED").length;
    const cancelledBookings = bookings.filter((b) => b.status === "CANCELLED").length;

    return res.json({
      bookings: bookings.map((b) => {
        const resident = residentMap.get(b.residentId);
        return {
          id: b.id,
          amenityId: b.amenityId,
          amenityName: b.amenity.name,
          amenityType: b.amenity.type,
          residentId: b.residentId,
          residentName: resident?.name || "Unknown",
          villaId: resident?.villaId || null,
          villa: resident?.villa
            ? {
                villaNumber: resident.villa.villaNumber,
                block: resident.villa.block,
                ownerName: resident.villa.ownerName,
              }
            : null,
          startTime: b.startTime,
          endTime: b.endTime,
          status: b.status,
          notes: b.notes,
        };
      }),
      summary: {
        totalBookings,
        activeBookings,
        cancelledBookings,
        amenityCount: Object.keys(byAmenity).length,
      },
      byAmenity: Object.entries(byAmenity).map(([amenityId, bks]) => ({
        amenityId,
        amenityName: bks[0].amenity.name,
        bookingCount: bks.length,
      })),
      byDate: Object.entries(byDate).map(([date, bks]) => ({
        date,
        displayDate: new Date(date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        bookingCount: bks.length,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/amenity-booking-calendar/amenities
// Get all amenities with booking counts
router.get("/amenities", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const amenities = await prisma.amenity.findMany({
      where: { societyId },
      include: {
        bookings: {
          where: {
            startTime: {
              gte: new Date(),
            },
            status: "CONFIRMED",
          },
        },
      },
      orderBy: { name: "asc" },
    });

    const amenitiesWithStats = amenities.map((amenity) => ({
      id: amenity.id,
      name: amenity.name,
      type: amenity.type,
      description: amenity.description,
      capacity: amenity.capacity,
      isActive: amenity.isActive,
      upcomingBookings: amenity.bookings.length,
      availability: amenity.isActive
        ? amenity.bookings.length < 10
          ? "AVAILABLE"
          : "BUSY"
        : "INACTIVE",
    }));

    return res.json({ amenities: amenitiesWithStats });
  } catch (error) {
    next(error);
  }
});

// GET /api/amenity-booking-calendar/daily/:date
// Get all bookings for a specific date
router.get("/daily/:date", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { date } = req.params;

    const targetDate = new Date(date);
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const bookings = await prisma.amenityBooking.findMany({
      where: {
        societyId,
        startTime: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      include: {
        amenity: {
          select: {
            name: true,
            type: true,
          },
        },
      },
      orderBy: { startTime: "asc" },
    });

    // Get resident/villa info
    const residentIds = [...new Set(bookings.map((b) => b.residentId))];
    const residents = await prisma.user.findMany({
      where: {
        id: { in: residentIds },
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
            block: true,
            ownerName: true,
          },
        },
      },
    });

    const residentMap = new Map(residents.map((r) => [r.id, r]));

    // Group by hour
    const hourlyBookings: { [hour: number]: any[] } = {};
    for (let i = 0; i < 24; i++) {
      hourlyBookings[i] = [];
    }

    bookings.forEach((b) => {
      const hour = new Date(b.startTime).getHours();
      const resident = residentMap.get(b.residentId);
      hourlyBookings[hour].push({
        id: b.id,
        amenityName: b.amenity.name,
        amenityType: b.amenity.type,
        residentName: resident?.name || "Unknown",
        villa: resident?.villa
          ? {
              villaNumber: resident.villa.villaNumber,
              block: resident.villa.block,
              ownerName: resident.villa.ownerName,
            }
          : null,
        startTime: b.startTime,
        endTime: b.endTime,
        status: b.status,
      });
    });

    return res.json({
      date: targetDate,
      totalBookings: bookings.length,
      bookings,
      hourlyBookings,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
