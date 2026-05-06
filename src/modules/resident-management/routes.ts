import { ResidentType, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

/** Display label for admin UI; must match resident-management table filters. */
function formatResidentTypeLabel(rt: ResidentType): string {
  switch (rt) {
    case ResidentType.TENANT:
      return "Tenant";
    case ResidentType.FAMILY_MEMBER:
      return "Family";
    case ResidentType.OWNER:
    default:
      return "Owner";
  }
}

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

// GET /api/resident-management/overview
// Get comprehensive overview of all residents
router.get("/overview", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { status, type, villaId } = req.query;

    // Build filter
    const where: any = {
      societyId,
      role: UserRole.RESIDENT,
    };

    if (status === "active") {
      where.isActive = true;
    } else if (status === "inactive") {
      where.isActive = false;
    }

    if (villaId) {
      where.villaId = villaId;
    }

    // Get all residents
    const residents = await prisma.user.findMany({
      where,
      include: {
        villa: {
          select: {
            id: true,
            villaNumber: true,
            block: true,
            ownerName: true,
            ownerEmail: true,
          },
        },
      },
      orderBy: [
        { isActive: "desc" },
        { moveInDate: "desc" },
      ],
    });

    // Calculate statistics
    const totalResidents = residents.length;
    const activeResidents = residents.filter((r) => r.isActive).length;
    const inactiveResidents = residents.filter((r) => !r.isActive).length;

    // Owners vs Tenants — use User.residentType (same source as table TYPE column)
    const activeList = residents.filter((r) => r.isActive);
    const owners = activeList.filter((r) => r.residentType === ResidentType.OWNER).length;
    const tenants = activeList.filter((r) => r.residentType === ResidentType.TENANT).length;

    // New this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const newThisMonth = residents.filter(
      (r) => r.moveInDate && new Date(r.moveInDate) >= startOfMonth
    ).length;

    // Moved out this month
    const movedOutThisMonth = residents.filter(
      (r) =>
        !r.isActive &&
        r.moveOutDate &&
        new Date(r.moveOutDate) >= startOfMonth
    ).length;

    // Format residents data
    const formattedResidents = residents.map((resident) => {
      const daysSinceMove = resident.moveInDate
        ? Math.floor(
            (Date.now() - new Date(resident.moveInDate).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : 0;

      return {
        id: resident.id,
        username: (resident as any).username || null,
        name: resident.name,
        email: resident.email,
        phone: resident.phone,
        villaId: resident.villaId,
        villa: resident.villa
          ? {
              villaNumber: resident.villa.villaNumber,
              block: resident.villa.block,
            }
          : null,
        type: formatResidentTypeLabel(resident.residentType),
        moveInDate: resident.moveInDate,
        moveOutDate: resident.moveOutDate,
        isActive: resident.isActive,
        daysSinceMove,
        createdAt: resident.createdAt,
      };
    });

    return res.json({
      statistics: {
        totalResidents,
        activeResidents,
        inactiveResidents,
        owners,
        tenants,
        newThisMonth,
        movedOutThisMonth,
        occupancyRate:
          totalResidents > 0
            ? Math.round((activeResidents / totalResidents) * 100)
            : 0,
      },
      residents: formattedResidents,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/resident-management/new-this-month
// Get residents who moved in this month
router.get("/new-this-month", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const newResidents = await prisma.user.findMany({
      where: {
        societyId,
        role: UserRole.RESIDENT,
        moveInDate: {
          gte: startOfMonth,
        },
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
            block: true,
          },
        },
      },
      orderBy: { moveInDate: "desc" },
    });

    return res.json({ newResidents });
  } catch (error) {
    next(error);
  }
});

// POST /api/resident-management/move-out
// Process move-out for a resident
const moveOutSchema = z.object({
  userId: z.string().cuid(),
  moveOutDate: z.string().datetime(),
  reason: z.string().optional(),
});

router.post("/move-out", validateBody(moveOutSchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { userId, moveOutDate, reason } = req.body as z.infer<
      typeof moveOutSchema
    >;

    // Check if user exists and is a resident
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        societyId,
        role: UserRole.RESIDENT,
      },
    });

    if (!user) {
      return res.status(404).json({ message: "Resident not found" });
    }

    if (!user.isActive) {
      return res
        .status(400)
        .json({ message: "Resident is already inactive" });
    }

    // Update user status
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        isActive: false,
        moveOutDate: new Date(moveOutDate),
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
            block: true,
          },
        },
      },
    });

    return res.json({
      message: "Move-out processed successfully",
      resident: updatedUser,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/resident-management/:id/reactivate
// Reactivate an inactive resident
router.patch("/:id/reactivate", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { societyId } = req.auth!;

    const user = await prisma.user.findFirst({
      where: {
        id,
        societyId,
        role: UserRole.RESIDENT,
      },
    });

    if (!user) {
      return res.status(404).json({ message: "Resident not found" });
    }

    if (user.isActive) {
      return res
        .status(400)
        .json({ message: "Resident is already active" });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        isActive: true,
        moveOutDate: null,
        moveInDate: new Date(), // Set new move-in date
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
            block: true,
          },
        },
      },
    });

    return res.json({
      message: "Resident reactivated successfully",
      resident: updatedUser,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/resident-management/villa/:villaId
// Get all residents for a specific villa
router.get("/villa/:villaId", async (req, res, next) => {
  try {
    const { villaId } = req.params;
    const { societyId } = req.auth!;

    const villa = await prisma.villa.findFirst({
      where: {
        id: villaId,
        societyId,
      },
    });

    if (!villa) {
      return res.status(404).json({ message: "Villa not found" });
    }

    const residents = await prisma.user.findMany({
      where: {
        villaId,
        role: UserRole.RESIDENT,
      },
      orderBy: [
        { isActive: "desc" },
        { moveInDate: "desc" },
      ],
    });

    const activeCount = residents.filter((r) => r.isActive).length;
    const inactiveCount = residents.filter((r) => !r.isActive).length;

    return res.json({
      villa: {
        villaNumber: villa.villaNumber,
        block: villa.block,
        ownerName: villa.ownerName,
      },
      statistics: {
        totalResidents: residents.length,
        activeCount,
        inactiveCount,
      },
      residents,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/resident-management/statistics
// Get detailed statistics
router.get("/statistics", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const allResidents = await prisma.user.findMany({
      where: {
        societyId,
        role: UserRole.RESIDENT,
      },
    });

    const active = allResidents.filter((r) => r.isActive);
    const inactive = allResidents.filter((r) => !r.isActive);

    // Owners vs Tenants — align with User.residentType (not villa.ownerEmail)
    const owners = active.filter((r) => r.residentType === ResidentType.OWNER);
    const tenants = active.filter((r) => r.residentType === ResidentType.TENANT);

    // Move-in trends (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const recentMoveIns = allResidents.filter(
      (r) => r.moveInDate && new Date(r.moveInDate) >= sixMonthsAgo
    );

    // Group by month
    const monthlyMoveIns: { [key: string]: number } = {};
    recentMoveIns.forEach((r) => {
      if (r.moveInDate) {
        const monthKey = `${new Date(r.moveInDate).getFullYear()}-${String(
          new Date(r.moveInDate).getMonth() + 1
        ).padStart(2, "0")}`;
        monthlyMoveIns[monthKey] = (monthlyMoveIns[monthKey] || 0) + 1;
      }
    });

    // Average tenancy duration
    const inactiveWithDuration = inactive.filter(
      (r) => r.moveInDate && r.moveOutDate
    );
    let avgTenancyDays = 0;
    if (inactiveWithDuration.length > 0) {
      const totalDays = inactiveWithDuration.reduce((sum, r) => {
        const duration =
          (new Date(r.moveOutDate!).getTime() -
            new Date(r.moveInDate!).getTime()) /
          (1000 * 60 * 60 * 24);
        return sum + duration;
      }, 0);
      avgTenancyDays = Math.round(totalDays / inactiveWithDuration.length);
    }

    return res.json({
      total: allResidents.length,
      active: active.length,
      inactive: inactive.length,
      owners: owners.length,
      tenants: tenants.length,
      occupancyRate: Math.round((active.length / allResidents.length) * 100),
      avgTenancyDays,
      monthlyMoveIns,
      recentMoveInsCount: recentMoveIns.length,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
