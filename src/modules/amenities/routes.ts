import { AmenityType, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const createAmenitySchema = z.object({
  name: z.string().min(2).max(100),
  type: z.nativeEnum(AmenityType),
  description: z.string().optional(),
  capacity: z.number().int().positive().optional(),
  /** 0 = free booking */
  pricePerHour: z.number().min(0).optional(),
  isActive: z.boolean().optional().default(true),
  openTime: z.string().optional(),
  closeTime: z.string().optional()
});

const updateAmenitySchema = z.object({
  name: z.string().min(2).max(100).optional(),
  type: z.nativeEnum(AmenityType).optional(),
  description: z.string().optional(),
  capacity: z.number().int().positive().optional(),
  pricePerHour: z.number().min(0).optional(),
  isActive: z.boolean().optional(),
  openTime: z.string().optional(),
  closeTime: z.string().optional()
});

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const isAdmin = req.auth!.role === UserRole.ADMIN;
    const amenities = await prisma.amenity.findMany({
      where: {
        societyId: req.auth!.societyId,
        ...(!isAdmin && { isActive: true })
      },
      orderBy: { name: "asc" }
    });
    return res.json({ amenities });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(createAmenitySchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createAmenitySchema>;
      const amenity = await prisma.amenity.create({
        data: {
          societyId: req.auth!.societyId,
          name: body.name,
          type: body.type,
          description: body.description,
          capacity: body.capacity,
          pricePerHour: body.pricePerHour,
          isActive: body.isActive,
          openTime: body.openTime,
          closeTime: body.closeTime
        }
      });
      return res.status(201).json({ amenity });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/:id",
  requireRole(UserRole.ADMIN),
  validateBody(updateAmenitySchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof updateAmenitySchema>;
      const { id } = req.params;

      const amenity = await prisma.amenity.updateMany({
        where: {
          id,
          societyId: req.auth!.societyId
        },
        data: body
      });

      if (amenity.count === 0) {
        return res.status(404).json({ message: "Amenity not found" });
      }

      return res.json({ message: "Amenity updated" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
