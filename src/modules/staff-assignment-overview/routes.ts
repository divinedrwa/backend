import { UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";

const router = Router();

router.use(requireAuth);
router.use(requireRole(UserRole.ADMIN));

// GET /api/staff-assignment-overview/staff-overview
// Get all staff with their villa assignments
router.get("/staff-overview", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const staff = await prisma.staff.findMany({
      where: { societyId },
      include: {
        assignments: {
          include: {
            villa: {
              select: {
                id: true,
                villaNumber: true,
                block: true,
                ownerName: true,
              },
            },
          },
          orderBy: {
            startDate: "desc",
          },
        },
      },
      orderBy: { name: "asc" },
    });

    const staffOverview = staff.map((s) => {
      const activeAssignments = s.assignments.filter((a) => a.isActive);
      const totalAssignments = s.assignments.length;

      return {
        id: s.id,
        name: s.name,
        type: s.type,
        phone: s.phone,
        idProof: s.idProof,
        isActive: s.isActive,
        totalAssignments,
        activeAssignments: activeAssignments.length,
        villas: activeAssignments.map((a) => ({
          villaId: a.villa.id,
          villaNumber: a.villa.villaNumber,
          block: a.villa.block,
          ownerName: a.villa.ownerName,
          startDate: a.startDate,
        })),
        lastAssignedAt:
          activeAssignments.length > 0
            ? activeAssignments[0].startDate
            : null,
      };
    });

    // Calculate summary statistics
    const totalStaff = staff.length;
    const activeStaff = staff.filter((s) => s.isActive).length;
    const assignedStaff = staffOverview.filter(
      (s) => s.activeAssignments > 0
    ).length;
    const unassignedStaff = activeStaff - assignedStaff;

    return res.json({
      staff: staffOverview,
      summary: {
        totalStaff,
        activeStaff,
        assignedStaff,
        unassignedStaff,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/staff-assignment-overview/villa-coverage
// Get villa coverage analysis
router.get("/villa-coverage", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const villas = await prisma.villa.findMany({
      where: { societyId },
      include: {
        staffAssignments: {
          where: { isActive: true },
          include: {
            staff: {
              select: {
                id: true,
                name: true,
                type: true,
                phone: true,
                isActive: true,
              },
            },
          },
        },
        users: {
          where: { 
            isActive: true,
            role: "RESIDENT"
          },
          select: {
            id: true,
            name: true,
            residentType: true,
          },
        },
      },
      orderBy: { villaNumber: "asc" },
    });

    type StaffAssignmentWithStaff = (typeof villas)[number]["staffAssignments"][number];

    const villasCoverage = villas.map((v) => {
      const activeStaff = v.staffAssignments.filter((a: StaffAssignmentWithStaff) => a.staff.isActive);
      return {
        id: v.id,
        villaNumber: v.villaNumber,
        block: v.block,
        ownerName: v.ownerName,
        hasActiveResident: v.users.length > 0,
        residentCount: v.users.length,
        staffCount: activeStaff.length,
        staff: activeStaff.map((a: StaffAssignmentWithStaff) => ({
          staffId: a.staff.id,
          name: a.staff.name,
          type: a.staff.type,
          phone: a.staff.phone,
          startDate: a.startDate,
        })),
      };
    });

    // Calculate coverage statistics
    const totalVillas = villas.length;
    const villasWithStaff = villasCoverage.filter(
      (v) => v.staffCount > 0
    ).length;
    const villasWithoutStaff = totalVillas - villasWithStaff;
    const occupiedVillasWithoutStaff = villasCoverage.filter(
      (v) => v.hasActiveResident && v.staffCount === 0
    ).length;

    return res.json({
      villas: villasCoverage,
      summary: {
        totalVillas,
        villasWithStaff,
        villasWithoutStaff,
        occupiedVillasWithoutStaff,
        coveragePercentage:
          totalVillas > 0
            ? Math.round((villasWithStaff / totalVillas) * 100)
            : 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/staff-assignment-overview/workload-distribution
// Get workload distribution analysis
router.get("/workload-distribution", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const staff = await prisma.staff.findMany({
      where: {
        societyId,
        isActive: true,
      },
      include: {
        assignments: {
          where: { isActive: true },
          select: { id: true },
        },
      },
    });

    const workloadData = staff.map((s) => ({
      staffId: s.id,
      name: s.name,
      type: s.type,
      villaCount: s.assignments.length,
    }));

    // Sort by workload (descending)
    workloadData.sort((a, b) => b.villaCount - a.villaCount);

    // Calculate workload categories
    const overloaded = workloadData.filter((w) => w.villaCount > 5).length;
    const balanced = workloadData.filter(
      (w) => w.villaCount >= 2 && w.villaCount <= 5
    ).length;
    const underutilized = workloadData.filter(
      (w) => w.villaCount === 1
    ).length;
    const unassigned = workloadData.filter((w) => w.villaCount === 0).length;

    // Calculate average workload
    const totalAssignments = workloadData.reduce(
      (sum, w) => sum + w.villaCount,
      0
    );
    const avgWorkload =
      staff.length > 0 ? (totalAssignments / staff.length).toFixed(1) : "0.0";

    // Group by type
    const typeBreakdown: {
      [type: string]: { count: number; totalAssignments: number };
    } = {};
    workloadData.forEach((w) => {
      if (!typeBreakdown[w.type]) {
        typeBreakdown[w.type] = { count: 0, totalAssignments: 0 };
      }
      typeBreakdown[w.type].count++;
      typeBreakdown[w.type].totalAssignments += w.villaCount;
    });

    const typeStats = Object.entries(typeBreakdown).map(([type, data]) => ({
      type,
      staffCount: data.count,
      totalAssignments: data.totalAssignments,
      avgPerStaff: (data.totalAssignments / data.count).toFixed(1),
    }));

    return res.json({
      workload: workloadData,
      summary: {
        totalStaff: staff.length,
        totalAssignments,
        avgWorkload,
        overloaded,
        balanced,
        underutilized,
        unassigned,
      },
      typeStats,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/staff-assignment-overview/quick-assign
// Quick assign/unassign staff to villa
const quickAssignSchema = z.object({
  staffId: z.string(),
  villaId: z.string(),
  action: z.enum(["assign", "unassign"]),
});

router.post("/quick-assign", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { staffId, villaId, action } = quickAssignSchema.parse(req.body);

    // Verify staff and villa belong to society
    const [staff, villa] = await Promise.all([
      prisma.staff.findFirst({
        where: { id: staffId, societyId },
      }),
      prisma.villa.findFirst({
        where: { id: villaId, societyId },
      }),
    ]);

    if (!staff) {
      return res.status(404).json({ message: "Staff not found" });
    }

    if (!villa) {
      return res.status(404).json({ message: "Villa not found" });
    }

    if (action === "assign") {
      // Check if already assigned
      const existing = await prisma.staffAssignment.findFirst({
        where: {
          staffId,
          villaId,
          isActive: true,
        },
      });

      if (existing) {
        return res
          .status(400)
          .json({ message: "Staff already assigned to this villa" });
      }

      // Create assignment
      const assignment = await prisma.staffAssignment.create({
        data: {
          staffId,
          villaId,
          isActive: true,
        },
      });

      // Fetch staff and villa details for response
      const [staffDetails, villaDetails] = await Promise.all([
        prisma.staff.findUnique({
          where: { id: staffId },
          select: { name: true, type: true },
        }),
        prisma.villa.findUnique({
          where: { id: villaId },
          select: { villaNumber: true, block: true },
        }),
      ]);

      return res.json({
        message: `${staffDetails?.name} assigned to Villa ${villaDetails?.villaNumber}`,
        assignment,
      });
    } else {
      // Unassign - mark as inactive
      const assignment = await prisma.staffAssignment.findFirst({
        where: {
          staffId,
          villaId,
          isActive: true,
        },
      });

      if (!assignment) {
        return res
          .status(404)
          .json({ message: "Active assignment not found" });
      }

      await prisma.staffAssignment.update({
        where: { id: assignment.id },
        data: { isActive: false },
      });

      return res.json({
        message: `Staff unassigned from Villa ${villa.villaNumber}`,
      });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    next(error);
  }
});

// GET /api/staff-assignment-overview/unassigned-resources
// Get list of unassigned staff and villas without staff
router.get("/unassigned-resources", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    // Get unassigned staff
    const allStaff = await prisma.staff.findMany({
      where: {
        societyId,
        isActive: true,
      },
      include: {
        assignments: {
          where: { isActive: true },
          select: { id: true },
        },
      },
    });

    const unassignedStaff = allStaff
      .filter((s) => s.assignments.length === 0)
      .map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        phone: s.phone,
        createdAt: s.createdAt,
        daysSinceCreation: Math.floor(
          (Date.now() - new Date(s.createdAt).getTime()) /
            (1000 * 60 * 60 * 24)
        ),
      }));

    // Get villas without staff
    const allVillas = await prisma.villa.findMany({
      where: { societyId },
      include: {
        staffAssignments: {
          where: { isActive: true },
          select: { id: true },
        },
        users: {
          where: { 
            isActive: true,
            role: "RESIDENT"
          },
          select: {
            id: true,
            name: true,
            residentType: true,
          },
        },
      },
    });

    const villasWithoutStaff = allVillas
      .filter((v) => v.staffAssignments.length === 0)
      .map((v) => ({
        id: v.id,
        villaNumber: v.villaNumber,
        block: v.block,
        ownerName: v.ownerName,
        hasActiveResident: v.users.length > 0,
        residentCount: v.users.length,
        residents: v.users.map((r) => ({
          name: r.name,
          type: r.residentType,
        })),
      }));

    // Prioritize occupied villas
    const occupiedWithoutStaff = villasWithoutStaff.filter(
      (v) => v.hasActiveResident
    );
    const vacantWithoutStaff = villasWithoutStaff.filter(
      (v) => !v.hasActiveResident
    );

    return res.json({
      unassignedStaff,
      villasWithoutStaff: {
        occupied: occupiedWithoutStaff,
        vacant: vacantWithoutStaff,
        total: villasWithoutStaff.length,
      },
      summary: {
        unassignedStaffCount: unassignedStaff.length,
        occupiedVillasWithoutStaff: occupiedWithoutStaff.length,
        vacantVillasWithoutStaff: vacantWithoutStaff.length,
        totalVillasWithoutStaff: villasWithoutStaff.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
