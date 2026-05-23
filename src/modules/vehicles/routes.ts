import { Prisma, UserRole, VehicleType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const createVehicleSchema = z.object({
  villaId: z.string().cuid(),
  vehicleNumber: z.string().min(2).max(20),
  vehicleType: z.nativeEnum(VehicleType),
  model: z.string().optional(),
  color: z.string().optional(),
  parkingSlot: z.string().optional(),
  rcCopy: z.string().optional()
});

const updateVehicleSchema = z.object({
  vehicleNumber: z.string().min(2).max(20).optional(),
  vehicleType: z.nativeEnum(VehicleType).optional(),
  model: z.string().optional(),
  color: z.string().optional(),
  parkingSlot: z.string().optional(),
  rcCopy: z.string().optional()
});

router.use(requireAuth);

// List vehicles
router.get("/", async (req, res, next) => {
  try {
    const whereClause: Prisma.VehicleWhereInput = {
      societyId: req.auth!.societyId
    };

    // Residents see only their villa's vehicles
    if (req.auth!.role === UserRole.RESIDENT && req.auth!.villaId) {
      whereClause.villaId = req.auth!.villaId;
    }

    const pagination = getPagination(req);
    const [raw, total] = await Promise.all([
      prisma.vehicle.findMany({
        where: whereClause,
        include: {
          villa: { select: { villaNumber: true, block: true, ownerName: true } },
        },
        orderBy: { createdAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.vehicle.count({ where: whereClause }),
    ]);

    const vehicles = raw.map((v) => ({
      id: v.id,
      vehicleNumber: v.registrationNumber,
      vehicleType: v.type,
      model: v.model,
      color: v.color,
      parkingSlot: v.parkingSlot,
      villa: v.villa,
      createdAt: v.createdAt,
    }));

    return res.json({ vehicles, ...paginationMeta(total, vehicles.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// Register vehicle
router.post(
  "/",
  validateBody(createVehicleSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createVehicleSchema>;

      // Verify villa access
      const villa = await prisma.villa.findFirst({
        where: {
          id: body.villaId,
          societyId: req.auth!.societyId
        }
      });

      if (!villa) {
        return res.status(404).json({ message: "Villa not found" });
      }

      // Residents can only register vehicle for their villa
      if (req.auth!.role === UserRole.RESIDENT) {
        if (req.auth!.villaId !== body.villaId) {
          return res.status(403).json({ message: "Cannot register vehicle for another villa" });
        }
      }

      const vehicleData: Prisma.VehicleUncheckedCreateInput = {
        societyId: req.auth!.societyId,
        villaId: body.villaId,
        registrationNumber: body.vehicleNumber.toUpperCase(),
        type: body.vehicleType,
        make: body.model?.trim() || "",
        model: body.model?.trim() || "",
        color: body.color?.trim() || "",
      };

      if (body.parkingSlot) vehicleData.parkingSlot = body.parkingSlot;
      if (body.rcCopy) vehicleData.rcCopy = body.rcCopy;

      const vehicle = await prisma.vehicle.create({
        data: vehicleData,
        include: {
          villa: {
            select: {
              villaNumber: true,
              block: true
            }
          }
        }
      });

      return res.status(201).json({
        vehicle: {
          id: vehicle.id,
          vehicleNumber: vehicle.registrationNumber,
          vehicleType: vehicle.type,
          model: vehicle.model,
          color: vehicle.color,
          parkingSlot: vehicle.parkingSlot,
          villa: vehicle.villa,
          createdAt: vehicle.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Update vehicle
router.patch(
  "/:id",
  validateBody(updateVehicleSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof updateVehicleSchema>;
      const { id } = req.params;

      const whereClause: Prisma.VehicleWhereInput = {
        id,
        societyId: req.auth!.societyId
      };

      // Residents can only update their villa's vehicles
      if (req.auth!.role === UserRole.RESIDENT && req.auth!.villaId) {
        whereClause.villaId = req.auth!.villaId;
      }

      const updateData: Prisma.VehicleUncheckedUpdateInput = {};
      if (body.vehicleNumber) {
        updateData.registrationNumber = body.vehicleNumber.toUpperCase();
      }
      if (body.vehicleType) updateData.type = body.vehicleType;
      if (body.model) {
        updateData.make = body.model.trim();
        updateData.model = body.model.trim();
      }
      if (body.color) updateData.color = body.color;
      if (body.parkingSlot !== undefined) updateData.parkingSlot = body.parkingSlot;
      if (body.rcCopy !== undefined) updateData.rcCopy = body.rcCopy;

      const vehicle = await prisma.vehicle.updateMany({
        where: whereClause,
        data: updateData
      });

      if (vehicle.count === 0) {
        return res.status(404).json({ message: "Vehicle not found" });
      }

      return res.json({ message: "Vehicle updated" });
    } catch (error) {
      next(error);
    }
  }
);

// Delete vehicle
router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    const whereClause: Prisma.VehicleWhereInput = {
      id,
      societyId: req.auth!.societyId
    };

    // Residents can only delete their villa's vehicles
    if (req.auth!.role === UserRole.RESIDENT && req.auth!.villaId) {
      whereClause.villaId = req.auth!.villaId;
    }

    const vehicle = await prisma.vehicle.deleteMany({
      where: whereClause
    });

    if (vehicle.count === 0) {
      return res.status(404).json({ message: "Vehicle not found" });
    }

    return res.json({ message: "Vehicle deleted" });
  } catch (error) {
    next(error);
  }
});

export default router;
