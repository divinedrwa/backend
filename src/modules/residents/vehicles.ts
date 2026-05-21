import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { UserRole } from "@prisma/client";

const router = Router();

router.use(requireAuth);

// Validation schemas
const registerVehicleSchema = z.object({
  registrationNumber: z.string().min(5).max(20),
  // Accept legacy mobile values and map to Prisma enum values.
  type: z.enum(["TWO_WHEELER", "FOUR_WHEELER", "HEAVY_VEHICLE", "BICYCLE", "OTHER"]),
  make: z.string().optional(),
  model: z.string().optional(),
  color: z.string().optional(),
  parkingSlot: z.string().optional(),
});

// GET /api/residents/my-vehicles - Get my vehicles
router.get("/my-vehicles", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    const raw = await prisma.vehicle.findMany({
      where: {
        villaId: user.villaId,
        societyId,
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const twoWheelers = raw.filter((v) => v.type === "TWO_WHEELER");
    const fourWheelers = raw.filter((v) => v.type === "FOUR_WHEELER");

    const vehicles = raw.map((v) => ({
      id: v.id,
      vehicleNumber: v.registrationNumber,
      type: v.type,
      make: v.make,
      model: v.model,
      color: v.color,
      parkingSlot: v.parkingSlot,
      villa: v.villa,
      createdAt: v.createdAt,
    }));

    return res.json({
      vehicles,
      summary: {
        total: vehicles.length,
        twoWheelers: twoWheelers.length,
        fourWheelers: fourWheelers.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/residents/register-vehicle - Register new vehicle
router.post("/register-vehicle", requireRole(UserRole.RESIDENT, UserRole.ADMIN), validateBody(registerVehicleSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { registrationNumber, type, make, model, color, parkingSlot } = req.body;
    const normalizedType = type === "HEAVY_VEHICLE" ? "OTHER" : type;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(400).json({ message: "Villa not assigned" });
    }

    // Check if vehicle already registered
    const existing = await prisma.vehicle.findFirst({
      where: {
        registrationNumber,
        societyId,
      },
    });

    if (existing) {
      return res.status(400).json({ message: "Vehicle already registered" });
    }

    const vehicle = await prisma.vehicle.create({
      data: {
        societyId,
        villaId: user.villaId,
        registrationNumber: registrationNumber.toUpperCase(),
        type: normalizedType,
        make: make?.trim() || "",
        model: model?.trim() || "",
        color: color?.trim() || "",
        parkingSlot,
      },
    });

    return res.status(201).json({
      message: "Vehicle registered successfully",
      vehicle: {
        id: vehicle.id,
        vehicleNumber: vehicle.registrationNumber,
        type: vehicle.type,
        make: vehicle.make,
        model: vehicle.model,
        color: vehicle.color,
        parkingSlot: vehicle.parkingSlot,
        createdAt: vehicle.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/residents/vehicles/:id - Update vehicle
router.patch("/vehicles/:id", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;
    const { make, model, color, parkingSlot } = req.body;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Verify ownership
    const existing = await prisma.vehicle.findFirst({
      where: {
        id,
        villaId: user.villaId,
        societyId,
      },
    });

    if (!existing) {
      return res.status(404).json({ message: "Vehicle not found" });
    }

    const updated = await prisma.vehicle.update({
      where: { id },
      data: {
        ...(make && { make }),
        ...(model && { model }),
        ...(color && { color }),
        ...(parkingSlot !== undefined && { parkingSlot }),
      },
    });

    return res.json({
      message: "Vehicle updated successfully",
      vehicle: {
        id: updated.id,
        vehicleNumber: updated.registrationNumber,
        type: updated.type,
        make: updated.make,
        model: updated.model,
        color: updated.color,
        parkingSlot: updated.parkingSlot,
        createdAt: updated.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/residents/vehicles/:id - Remove vehicle
router.delete("/vehicles/:id", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Verify ownership
    const existing = await prisma.vehicle.findFirst({
      where: {
        id,
        villaId: user.villaId,
        societyId,
      },
    });

    if (!existing) {
      return res.status(404).json({ message: "Vehicle not found" });
    }

    await prisma.vehicle.delete({ where: { id } });

    return res.json({ message: "Vehicle removed successfully" });
  } catch (error) {
    next(error);
  }
});

export default router;
