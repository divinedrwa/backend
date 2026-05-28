import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { BookingStatus, UserRole } from "@prisma/client";

const router = Router();

router.use(requireAuth);

// Validation schema
const bookAmenitySchema = z.object({
  amenityId: z.string().min(1),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  notes: z.string().trim().optional(),
});

// GET /api/residents/my-bookings - Get my bookings
router.get("/my-bookings", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { status } = req.query;

    const bookings = await prisma.amenityBooking.findMany({
      where: {
        residentId: userId,
        societyId,
        ...(status && { status: status as BookingStatus }),
      },
      include: {
        amenity: {
          select: {
            name: true,
            type: true,
            location: true,
            pricePerHour: true,
          },
        },
      },
      orderBy: { startTime: "desc" },
      take: 50,
    });

    // Calculate summary
    const upcoming = bookings.filter((b) => new Date(b.startTime) > new Date() && b.status === "CONFIRMED");
    const pending = bookings.filter((b) => b.status === "PENDING");
    const completed = bookings.filter((b) => new Date(b.endTime) < new Date() && b.status === "CONFIRMED");

    return res.json({
      bookings,
      summary: {
        total: bookings.length,
        upcoming: upcoming.length,
        pending: pending.length,
        completed: completed.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/bookings-upcoming - Get upcoming bookings
router.get("/bookings-upcoming", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    const now = new Date();

    const upcomingBookings = await prisma.amenityBooking.findMany({
      where: {
        residentId: userId,
        societyId,
        startTime: { gte: now },
        status: "CONFIRMED",
      },
      include: {
        amenity: {
          select: {
            name: true,
            type: true,
            location: true,
          },
        },
      },
      orderBy: { startTime: "asc" },
    });

    return res.json({
      bookings: upcomingBookings,
      count: upcomingBookings.length,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/residents/book-amenity - Create booking
router.post("/book-amenity", requireRole(UserRole.RESIDENT, UserRole.ADMIN), validateBody(bookAmenitySchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { amenityId, startTime, endTime, notes } = req.body;

    // Verify amenity exists
    const amenity = await prisma.amenity.findFirst({
      where: { id: amenityId, societyId, isActive: true },
    });

    if (!amenity) {
      return res.status(404).json({ message: "Amenity not found or inactive" });
    }

    // Check for conflicts
    const conflicts = await prisma.amenityBooking.findMany({
      where: {
        amenityId,
        societyId,
        status: { in: ["PENDING", "CONFIRMED"] },
        OR: [
          {
            AND: [
              { startTime: { lte: new Date(startTime) } },
              { endTime: { gte: new Date(startTime) } },
            ],
          },
          {
            AND: [
              { startTime: { lte: new Date(endTime) } },
              { endTime: { gte: new Date(endTime) } },
            ],
          },
        ],
      },
    });

    if (conflicts.length > 0) {
      return res.status(400).json({ message: "Time slot not available" });
    }

    // Calculate price
    const hours = (new Date(endTime).getTime() - new Date(startTime).getTime()) / (1000 * 60 * 60);
    const totalPrice = hours * Number(amenity.pricePerHour || 0);

    const booking = await prisma.amenityBooking.create({
      data: {
        societyId,
        amenityId,
        residentId: userId,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        totalPrice,
        notes,
        status: "PENDING", // Requires admin approval
      },
      include: {
        amenity: {
          select: {
            name: true,
            type: true,
          },
        },
      },
    });

    return res.status(201).json({
      message: "Booking request submitted. Awaiting approval.",
      booking,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/residents/bookings/:id/cancel - Cancel booking
router.patch("/bookings/:id/cancel", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;

    // Verify ownership
    const booking = await prisma.amenityBooking.findFirst({
      where: {
        id,
        residentId: userId,
        societyId,
      },
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // Check if already started
    if (new Date(booking.startTime) < new Date()) {
      return res.status(400).json({ message: "Cannot cancel ongoing or past booking" });
    }

    if (booking.status === "CANCELLED") {
      return res.status(400).json({ message: "Booking already cancelled" });
    }

    const updated = await prisma.amenityBooking.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    return res.json({
      message: "Booking cancelled successfully",
      booking: updated,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/amenities-available - Get available amenities
// GET /api/residents/my-amenities - Alias for mobile app
router.get(["/amenities-available", "/my-amenities"], requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const amenities = await prisma.amenity.findMany({
      where: {
        societyId,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        type: true,
        description: true,
        location: true,
        capacity: true,
        pricePerHour: true,
        openTime: true,
        closeTime: true,
      },
      orderBy: { name: "asc" },
    });

    return res.json({ amenities, count: amenities.length });
  } catch (error) {
    next(error);
  }
});

export default router;
