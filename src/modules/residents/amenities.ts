import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { BookingStatus, Prisma, UserRole } from "@prisma/client";

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

    // Check for conflicts. Standard overlap test — two ranges overlap iff
    // existing.start < new.end AND existing.end > new.start. This catches
    // partial, fully-contained, AND fully-enveloping overlaps (the previous
    // OR missed the enveloping case). Strict comparisons allow back-to-back
    // slots (an existing booking ending exactly when the new one starts).
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    const hours = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60);
    const totalPrice = hours * Number(amenity.pricePerHour || 0);

    // Atomically re-check for an overlapping booking and create, so two
    // residents booking the same slot concurrently can't both succeed (the
    // former check-then-create had a TOCTOU gap). Serializable makes the
    // read+insert conflict-safe; retry once on a serialization failure.
    const runBooking = () =>
      prisma.$transaction(
        async (tx) => {
          const conflict = await tx.amenityBooking.findFirst({
            where: {
              amenityId,
              societyId,
              status: { in: ["PENDING", "CONFIRMED"] },
              startTime: { lt: endDate },
              endTime: { gt: startDate },
            },
            select: { id: true },
          });
          if (conflict) return { conflict: true as const, booking: null };
          const created = await tx.amenityBooking.create({
            data: {
              societyId,
              amenityId,
              residentId: userId,
              startTime: startDate,
              endTime: endDate,
              totalPrice,
              notes,
              status: "PENDING", // Requires admin approval
            },
            include: { amenity: { select: { name: true, type: true } } },
          });
          return { conflict: false as const, booking: created };
        },
        { isolationLevel: "Serializable" },
      );

    let result: Awaited<ReturnType<typeof runBooking>>;
    try {
      result = await runBooking();
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2034"
      ) {
        result = await runBooking();
      } else {
        throw e;
      }
    }

    if (result.conflict) {
      return res.status(409).json({ message: "Time slot not available" });
    }

    return res.status(201).json({
      message: "Booking request submitted. Awaiting approval.",
      booking: result.booking,
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
