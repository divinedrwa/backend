import { BookingStatus, Prisma, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole, isAdminLikeRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { notifyResidentAmenityBookingStatusChanged } from "../../services/amenityBookingNotification.service";

const router = Router();

const createBookingSchema = z.object({
  amenityId: z.string().cuid(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  notes: z.string().trim().optional()
});

const updateBookingStatusSchema = z.object({
  status: z.nativeEnum(BookingStatus)
});

router.use(requireAuth);

// List bookings (all for admin, own for residents)
router.get("/", async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const whereClause: Prisma.AmenityBookingWhereInput = {
      societyId: req.auth!.societyId
    };

    // Residents see only their bookings
    if (req.auth!.role === UserRole.RESIDENT) {
      whereClause.residentId = req.auth!.userId;
    }

    const [bookings, total] = await Promise.all([
      prisma.amenityBooking.findMany({
        where: whereClause,
        include: {
          amenity: {
            select: {
              id: true,
              name: true,
              type: true
            }
          },
          resident: {
            select: {
              id: true,
              name: true
            }
          }
        },
        orderBy: { startTime: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.amenityBooking.count({ where: whereClause }),
    ]);

    return res.json({ bookings, ...paginationMeta(total, bookings.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// Create booking (residents)
router.post(
  "/",
  validateBody(createBookingSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createBookingSchema>;

      // Verify amenity exists
      const amenity = await prisma.amenity.findFirst({
        where: {
          id: body.amenityId,
          societyId: req.auth!.societyId,
          isActive: true
        }
      });

      if (!amenity) {
        return res.status(404).json({ message: "Amenity not found or inactive" });
      }

      const startTime = new Date(body.startTime);
      const endTime = new Date(body.endTime);

      // Calculate price outside transaction (read-only)
      let totalPrice = null;
      if (amenity.pricePerHour) {
        const hours = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);
        totalPrice = new Prisma.Decimal(Number(amenity.pricePerHour) * hours);
      }

      // Serializable transaction: conflict check + create are atomic,
      // preventing double-booking from concurrent requests.
      const booking = await prisma.$transaction(
        async (tx) => {
          const conflict = await tx.amenityBooking.findFirst({
            where: {
              amenityId: body.amenityId,
              status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
              OR: [
                // New slot starts inside an existing booking
                {
                  AND: [
                    { startTime: { lte: startTime } },
                    { endTime: { gt: startTime } },
                  ],
                },
                // New slot ends inside an existing booking
                {
                  AND: [
                    { startTime: { lt: endTime } },
                    { endTime: { gte: endTime } },
                  ],
                },
                // New slot fully contains an existing booking
                {
                  AND: [
                    { startTime: { gte: startTime } },
                    { endTime: { lte: endTime } },
                  ],
                },
              ],
            },
          });

          if (conflict) {
            throw Object.assign(new Error("Time slot already booked"), { statusCode: 400 });
          }

          return tx.amenityBooking.create({
            data: {
              societyId: req.auth!.societyId,
              amenityId: body.amenityId,
              residentId: req.auth!.userId,
              startTime,
              endTime,
              totalPrice,
              notes: body.notes,
            },
            include: {
              amenity: {
                select: { id: true, name: true, type: true },
              },
              resident: {
                select: { id: true, name: true },
              },
            },
          });
        },
        { isolationLevel: "Serializable" },
      );

      return res.status(201).json({ booking });
    } catch (error) {
      if (error instanceof Error && (error as { statusCode?: number }).statusCode === 400) {
        return res.status(400).json({ message: error.message });
      }
      next(error);
    }
  }
);

// Update booking status (admin)
router.patch(
  "/:id/status",
  requireRole(UserRole.ADMIN),
  validateBody(updateBookingStatusSchema),
  async (req, res, next) => {
    try {
      const { status } = req.body as z.infer<typeof updateBookingStatusSchema>;
      const { id } = req.params;
      const societyId = req.auth!.societyId;

      const existing = await prisma.amenityBooking.findFirst({
        where: { id, societyId },
        include: {
          amenity: { select: { name: true } },
        },
      });

      if (!existing) {
        return res.status(404).json({ message: "Booking not found" });
      }

      if (existing.status === status) {
        return res.json({ message: "Booking status unchanged" });
      }

      const updated = await prisma.amenityBooking.update({
        where: { id },
        data: { status },
        include: {
          amenity: {
            select: {
              id: true,
              name: true,
              type: true,
            },
          },
          resident: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      void notifyResidentAmenityBookingStatusChanged({
        residentUserId: existing.residentId,
        societyId,
        bookingId: id,
        amenityName: existing.amenity?.name ?? "Amenity",
        previousStatus: existing.status,
        newStatus: status,
      });

      return res.json({ message: "Booking status updated", booking: updated });
    } catch (error) {
      next(error);
    }
  }
);

// Cancel booking (resident can cancel own, admin can cancel any)
router.delete("/:id", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { id } = req.params;
    const societyId = req.auth!.societyId;
    const role = req.auth!.role;

    const whereClause: { id: string; societyId: string; residentId?: string } = {
      id,
      societyId,
    };

    if (role === UserRole.RESIDENT) {
      whereClause.residentId = req.auth!.userId;
    }

    const existing = await prisma.amenityBooking.findFirst({
      where: whereClause,
      include: {
        amenity: { select: { name: true } },
      },
    });

    if (!existing) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (existing.status === BookingStatus.CANCELLED) {
      return res.status(400).json({ message: "Booking already cancelled" });
    }

    await prisma.amenityBooking.update({
      where: { id },
      data: { status: BookingStatus.CANCELLED },
    });

    if (isAdminLikeRole(role)) {
      void notifyResidentAmenityBookingStatusChanged({
        residentUserId: existing.residentId,
        societyId,
        bookingId: id,
        amenityName: existing.amenity?.name ?? "Amenity",
        previousStatus: existing.status,
        newStatus: BookingStatus.CANCELLED,
      });
    }

    return res.json({ message: "Booking cancelled" });
  } catch (error) {
    next(error);
  }
});

export default router;
