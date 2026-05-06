import { ParcelStatus, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const createParcelSchema = z.object({
  villaId: z.string().cuid(),
  description: z.string().min(3).max(200)
});

const updateParcelStatusSchema = z.object({
  status: z.nativeEnum(ParcelStatus)
});

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const parcels = await prisma.parcel.findMany({
      where: { societyId: req.auth!.societyId },
      include: {
        villa: {
          select: {
            villaNumber: true,
            block: true,
            ownerName: true
          }
        }
      },
      orderBy: { receivedAt: "desc" },
      take: 100
    });
    return res.json({ parcels });
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
          description: body.description
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
      return res.status(201).json({ parcel });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/:id/status",
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

export default router;
