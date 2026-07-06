import { UserRole } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN, UserRole.RESIDENT_CUM_ADMIN));

// GET /api/parking-management/overview
// Get parking overview with all vehicles and slot usage
router.get("/overview", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const vehicles = await prisma.vehicle.findMany({
      where: { societyId },
      include: {
        villa: {
          select: {
            villaNumber: true,
            block: true,
            ownerName: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Analyze parking slots
    const slotMap: Record<string, typeof vehicles> = {};
    vehicles.forEach((v) => {
      if (v.parkingSlot) {
        if (!slotMap[v.parkingSlot]) slotMap[v.parkingSlot] = [];
        slotMap[v.parkingSlot].push(v);
      }
    });

    const totalSlots = Object.keys(slotMap).length;
    const occupiedSlots = Object.keys(slotMap).filter((s) => slotMap[s].length > 0).length;
    const availableSlots = Math.max(0, totalSlots - occupiedSlots);

    // Vehicles by type
    const typeBreakdown: { [type: string]: number } = {};
    vehicles.forEach((v) => {
      typeBreakdown[v.type] = (typeBreakdown[v.type] || 0) + 1;
    });

    // Vehicles with/without slots
    const withSlots = vehicles.filter((v) => v.parkingSlot).length;
    const withoutSlots = vehicles.length - withSlots;

    // Villas by vehicle count
    const villaVehicleCount: { [villaId: string]: number } = {};
    vehicles.forEach((v) => {
      if (v.villaId) {
        villaVehicleCount[v.villaId] = (villaVehicleCount[v.villaId] || 0) + 1;
      }
    });

    const villasWithMultipleVehicles = Object.values(villaVehicleCount).filter((count) => count > 1).length;

    return res.json({
      summary: {
        totalVehicles: vehicles.length,
        totalSlots,
        occupiedSlots,
        availableSlots,
        withSlots,
        withoutSlots,
        villasWithMultipleVehicles,
      },
      typeBreakdown,
      vehicles: vehicles.map((v) => ({
        id: v.id,
        type: v.type,
        registrationNumber: v.registrationNumber,
        model: v.model,
        color: v.color,
        parkingSlot: v.parkingSlot,
        villaId: v.villaId,
        villa: v.villa
          ? {
              villaNumber: v.villa.villaNumber,
              block: v.villa.block,
              ownerName: v.villa.ownerName,
            }
          : null,
        rcCopy: v.rcCopy,
        createdAt: v.createdAt,
      })),
      slotUsage: Object.entries(slotMap).map(([slot, vehs]) => ({
        slot,
        vehicleCount: vehs.length,
        vehicles: vehs.map((v) => ({
          id: v.id,
          type: v.type,
          registrationNumber: v.registrationNumber,
        })),
      })),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/parking-management/slot-analysis
// Detailed slot-by-slot analysis
router.get("/slot-analysis", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const vehicles = await prisma.vehicle.findMany({
      where: { societyId },
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

    // Group by slot
    const slotMap: Record<string, Array<{
      id: string;
      type: string;
      registrationNumber: string;
      model: string | null;
      color: string | null;
      villa: (typeof vehicles)[number]["villa"];
      villaId: string | null;
    }>> = {};
    const unassignedVehicles: Array<{
      id: string;
      type: string;
      registrationNumber: string;
      model: string | null;
      color: string | null;
      villa: (typeof vehicles)[number]["villa"];
      villaId: string | null;
    }> = [];

    vehicles.forEach((v) => {
      if (v.parkingSlot) {
        if (!slotMap[v.parkingSlot]) slotMap[v.parkingSlot] = [];
        slotMap[v.parkingSlot].push({
          id: v.id,
          type: v.type,
          registrationNumber: v.registrationNumber,
          model: v.model,
          color: v.color,
          villa: v.villa,
          villaId: v.villaId,
        });
      } else {
        unassignedVehicles.push({
          id: v.id,
          type: v.type,
          registrationNumber: v.registrationNumber,
          model: v.model,
          color: v.color,
          villa: v.villa,
          villaId: v.villaId,
        });
      }
    });

    const slots = Object.entries(slotMap)
      .map(([slot, vehs]) => ({
        slot,
        status: vehs.length > 0 ? "OCCUPIED" : "AVAILABLE",
        vehicleCount: vehs.length,
        vehicles: vehs,
      }))
      .sort((a, b) => a.slot.localeCompare(b.slot));

    return res.json({
      slots,
      unassignedVehicles,
      summary: {
        totalSlots: slots.length,
        occupiedSlots: slots.filter((s) => s.status === "OCCUPIED").length,
        availableSlots: slots.filter((s) => s.status === "AVAILABLE").length,
        unassignedCount: unassignedVehicles.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/parking-management/villa-vehicles
// Vehicles grouped by villa
router.get("/villa-vehicles", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const villas = await prisma.villa.findMany({
      where: { societyId },
      include: {
        vehicles: {
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { villaNumber: "asc" },
    });

    const villaVehicles = villas.map((villa) => ({
      villaId: villa.id,
      villaNumber: villa.villaNumber,
      block: villa.block,
      ownerName: villa.ownerName,
      vehicleCount: villa.vehicles.length,
      vehicles: villa.vehicles.map((v) => ({
        id: v.id,
        type: v.type,
        registrationNumber: v.registrationNumber,
        model: v.model,
        color: v.color,
        parkingSlot: v.parkingSlot,
        rcCopy: v.rcCopy,
      })),
    }));

    const summary = {
      totalVillas: villas.length,
      villasWithVehicles: villaVehicles.filter((v) => v.vehicleCount > 0).length,
      villasWithoutVehicles: villaVehicles.filter((v) => v.vehicleCount === 0).length,
      avgVehiclesPerVilla: (
        villaVehicles.reduce((sum, v) => sum + v.vehicleCount, 0) / villas.length
      ).toFixed(1),
    };

    return res.json({ villaVehicles, summary });
  } catch (error) {
    next(error);
  }
});

export default router;
