import { NotificationCategory, Prisma, ParcelStatus, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { notifyUsers } from "../../services/notification.service";
import { residentLikeRoleFilter } from "../../lib/residentLike";

const router = Router();

const createParcelSchema = z.object({
  villaId: z.string().cuid(),
  description: z.string().trim().min(3).max(200)
});

const updateParcelStatusSchema = z.object({
  status: z.nativeEnum(ParcelStatus)
});

router.use(requireAuth);

router.get("/", requireRole(UserRole.ADMIN, UserRole.GUARD), async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const societyId = req.auth!.societyId;
    const { search, status, startDate, endDate } = req.query;
    const where: Prisma.ParcelWhereInput = { societyId };

    if (typeof search === "string" && search.trim()) {
      const term = search.trim();
      where.OR = [
        { description: { contains: term, mode: "insensitive" } },
        { villa: { villaNumber: { contains: term, mode: "insensitive" } } },
        { villa: { ownerName: { contains: term, mode: "insensitive" } } },
      ];
    }
    if (typeof status === "string" && status.trim()) {
      where.status = status.trim() as ParcelStatus;
    }
    if (typeof startDate === "string" && typeof endDate === "string") {
      where.receivedAt = { gte: new Date(startDate), lte: new Date(endDate) };
    }

    const [parcels, total, pendingCount] = await Promise.all([
      prisma.parcel.findMany({
        where,
        include: {
          villa: { select: { villaNumber: true, block: true, ownerName: true } },
        },
        orderBy: { receivedAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.parcel.count({ where }),
      prisma.parcel.count({
        where: { societyId, status: { notIn: ["DELIVERED", "COLLECTED"] } },
      }),
    ]);
    return res.json({ parcels, pendingCount, ...paginationMeta(total, parcels.length, pagination) });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/",
  requireRole(UserRole.GUARD, UserRole.ADMIN),
  validateBody(createParcelSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createParcelSchema>;

      const villa = await prisma.villa.findFirst({
        where: {
          id: body.villaId,
          societyId: req.auth!.societyId
        }
      });

      if (!villa) {
        return res.status(404).json({ message: "Villa not found" });
      }

      const parcel = await prisma.parcel.create({
        data: {
          societyId: req.auth!.societyId,
          villaId: body.villaId,
          description: body.description,
          status: ParcelStatus.RECEIVED,
        },
        include: {
          villa: {
            select: {
              villaNumber: true,
              block: true,
              ownerName: true
            }
          }
        }
      });
      // Notify villa residents about new parcel
      void (async () => {
        try {
          const residents = await prisma.user.findMany({
            where: {
              villaId: body.villaId,
              societyId: req.auth!.societyId,
              ...residentLikeRoleFilter,
              isActive: true,
            },
            select: { id: true },
          });
          if (residents.length > 0) {
            await notifyUsers(
              residents.map((r) => r.id),
              {
                title: "New parcel received",
                body: `A parcel has been received for villa ${villa.villaNumber}.${body.description ? ` (${body.description})` : ""}`,
                data: { type: "PARCEL_RECEIVED", parcelId: parcel.id, villaId: body.villaId },
              },
              { category: NotificationCategory.SYSTEM },
            );
          }
        } catch {
          // Fire-and-forget
        }
      })();

      return res.status(201).json({ parcel });
    } catch (error) {
      next(error);
    }
  }
);

const updateParcelSchema = z.object({
  description: z.string().trim().min(3).max(200),
});

router.put(
  "/:id",
  requireRole(UserRole.ADMIN),
  validateBody(updateParcelSchema),
  async (req, res, next) => {
    try {
      const { description } = req.body as z.infer<typeof updateParcelSchema>;
      const { id } = req.params;

      const parcel = await prisma.parcel.updateMany({
        where: {
          id,
          societyId: req.auth!.societyId,
        },
        data: { description },
      });

      if (parcel.count === 0) {
        return res.status(404).json({ message: "Parcel not found" });
      }

      return res.json({ message: "Parcel updated" });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/:id/status",
  requireRole(UserRole.GUARD, UserRole.ADMIN),
  validateBody(updateParcelStatusSchema),
  async (req, res, next) => {
    try {
      const { status } = req.body as z.infer<typeof updateParcelStatusSchema>;
      const { id } = req.params;

      const updateData: { status: ParcelStatus; collectedAt?: Date } = { status };
      if (status === ParcelStatus.COLLECTED) {
        updateData.collectedAt = new Date();
      }

      const parcel = await prisma.parcel.updateMany({
        where: {
          id,
          societyId: req.auth!.societyId
        },
        data: updateData
      });

      if (parcel.count === 0) {
        return res.status(404).json({ message: "Parcel not found" });
      }

      return res.json({ message: "Parcel status updated" });
    } catch (error) {
      next(error);
    }
  }
);

// Delete parcel (admin only)
router.delete(
  "/:id",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const parcel = await prisma.parcel.deleteMany({
        where: { id, societyId: req.auth!.societyId },
      });

      if (parcel.count === 0) {
        return res.status(404).json({ message: "Parcel not found" });
      }

      return res.json({ message: "Parcel deleted" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
