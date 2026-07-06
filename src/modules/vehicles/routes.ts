import {
  Prisma,
  UserRole,
  VehicleRegistrationCategory,
  VehicleRegistrationSource,
  VehicleType,
} from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, isAdminLikeRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { auditFromRequest } from "../../services/audit.service";
import {
  buildApprovedVehicleSearchWhere,
  mapVehicleToApi,
  normalizeRegistrationNumber,
  registrationDigitsOnly,
  vehicleInclude,
} from "../../lib/vehicleRegistration";

const router = Router();

const createVehicleSchema = z
  .object({
    registrationCategory: z
      .enum(["RESIDENT", "VISITOR", "OTHER"])
      .default("RESIDENT"),
    villaId: z.string().cuid().optional(),
    vehicleNumber: z.string().trim().min(2).max(20),
    vehicleType: z.nativeEnum(VehicleType),
    model: z.string().trim().optional(),
    color: z.string().trim().optional(),
    parkingSlot: z.string().trim().optional(),
    ownerLabel: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    rcCopy: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.registrationCategory === "RESIDENT" && !data.villaId) {
      ctx.addIssue({
        code: "custom",
        message: "Villa is required for resident vehicles",
        path: ["villaId"],
      });
    }
    if (
      (data.registrationCategory === "VISITOR" || data.registrationCategory === "OTHER") &&
      !data.ownerLabel?.trim()
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Owner / description is required for visitor and other vehicles",
        path: ["ownerLabel"],
      });
    }
  });

const updateVehicleSchema = z.object({
  vehicleNumber: z.string().trim().min(2).max(20).optional(),
  vehicleType: z.nativeEnum(VehicleType).optional(),
  model: z.string().trim().optional(),
  color: z.string().trim().optional(),
  parkingSlot: z.string().trim().optional(),
  ownerLabel: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  rcCopy: z.string().optional(),
  registrationCategory: z.enum(["RESIDENT", "VISITOR", "OTHER"]).optional(),
});

router.use(requireAuth);

function canManageSocietyVehicles(role: UserRole): boolean {
  return role === UserRole.SUPER_ADMIN || isAdminLikeRole(role);
}

// List vehicles
router.get("/", async (req, res, next) => {
  try {
    const societyId = req.auth!.societyId;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const category =
      typeof req.query.category === "string" ? req.query.category : undefined;

    const whereClause: Prisma.VehicleWhereInput = buildApprovedVehicleSearchWhere(
      societyId,
      search || undefined,
      category,
    );

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
      registrationCategory: v.registrationCategory,
      source: v.source,
      status: v.status,
      ownerLabel: v.ownerLabel,
      notes: v.notes,
      villa: v.villa,
      createdAt: v.createdAt,
    }));

    return res.json({ vehicles, ...paginationMeta(total, vehicles.length, pagination) });
  } catch (error) {
    next(error);
  }
});

// Register vehicle
router.post("/", validateBody(createVehicleSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createVehicleSchema>;
    const auth = req.auth!;

    if (!canManageSocietyVehicles(auth.role)) {
      return res.status(403).json({ message: "Only admins can register vehicles from this endpoint" });
    }

    if (body.villaId) {
      const villa = await prisma.villa.findFirst({
        where: { id: body.villaId, societyId: auth.societyId },
      });
      if (!villa) {
        return res.status(404).json({ message: "Villa not found" });
      }
    }

    const registrationNumber = normalizeRegistrationNumber(body.vehicleNumber);
    const vehicleData: Prisma.VehicleUncheckedCreateInput = {
      societyId: auth.societyId,
      villaId: body.villaId ?? null,
      registrationNumber,
      registrationDigits: registrationDigitsOnly(registrationNumber),
      type: body.vehicleType,
      make: body.model?.trim() || "",
      model: body.model?.trim() || "",
      color: body.color?.trim() || "",
      registrationCategory: body.registrationCategory as VehicleRegistrationCategory,
      source: VehicleRegistrationSource.ADMIN,
      status: "APPROVED",
      ownerLabel: body.ownerLabel?.trim() || null,
      notes: body.notes?.trim() || null,
    };

    if (body.parkingSlot) vehicleData.parkingSlot = body.parkingSlot;
    if (body.rcCopy) vehicleData.rcCopy = body.rcCopy;

    const vehicle = await prisma.vehicle.create({
      data: vehicleData,
      include: vehicleInclude,
    });

    return res.status(201).json({ vehicle: mapVehicleToApi(vehicle) });
  } catch (error) {
    next(error);
  }
});

// Update vehicle
router.patch("/:id", validateBody(updateVehicleSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof updateVehicleSchema>;
    const { id } = req.params;

    const whereClause: Prisma.VehicleWhereInput = {
      id,
      societyId: req.auth!.societyId,
    };

    if (req.auth!.role === UserRole.RESIDENT && req.auth!.villaId) {
      whereClause.villaId = req.auth!.villaId;
    }

    const updateData: Prisma.VehicleUncheckedUpdateInput = {};
    if (body.vehicleNumber) {
      const registrationNumber = normalizeRegistrationNumber(body.vehicleNumber);
      updateData.registrationNumber = registrationNumber;
      updateData.registrationDigits = registrationDigitsOnly(registrationNumber);
    }
    if (body.vehicleType) updateData.type = body.vehicleType;
    if (body.model) {
      updateData.make = body.model.trim();
      updateData.model = body.model.trim();
    }
    if (body.color) updateData.color = body.color;
    if (body.parkingSlot !== undefined) updateData.parkingSlot = body.parkingSlot;
    if (body.ownerLabel !== undefined) updateData.ownerLabel = body.ownerLabel.trim() || null;
    if (body.notes !== undefined) updateData.notes = body.notes.trim() || null;
    if (body.rcCopy !== undefined) updateData.rcCopy = body.rcCopy;
    if (body.registrationCategory) {
      updateData.registrationCategory = body.registrationCategory;
    }

    const vehicle = await prisma.vehicle.updateMany({
      where: whereClause,
      data: updateData,
    });

    if (vehicle.count === 0) {
      return res.status(404).json({ message: "Vehicle not found" });
    }

    return res.json({ message: "Vehicle updated" });
  } catch (error) {
    next(error);
  }
});

// Delete vehicle
router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    const whereClause: Prisma.VehicleWhereInput = {
      id,
      societyId: req.auth!.societyId,
    };

    if (req.auth!.role === UserRole.RESIDENT && req.auth!.villaId) {
      whereClause.villaId = req.auth!.villaId;
    }

    const vehicle = await prisma.vehicle.deleteMany({
      where: whereClause,
    });

    if (vehicle.count === 0) {
      return res.status(404).json({ message: "Vehicle not found" });
    }

    auditFromRequest(req, {
      adminId: req.auth!.userId,
      societyId: req.auth!.societyId,
      action: "VEHICLE_DELETED",
      entityType: "Vehicle",
      entityId: id,
    });

    return res.json({ message: "Vehicle deleted" });
  } catch (error) {
    next(error);
  }
});

export default router;
