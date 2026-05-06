import { StaffType, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const createStaffSchema = z.object({
  name: z.string().min(2).max(100),
  type: z.nativeEnum(StaffType),
  phone: z.string().min(10).max(15),
  address: z.string().optional(),
  idProof: z.string().optional(),
  photo: z.string().optional(),
  villaIds: z.array(z.string().cuid()).min(1), // Array of villa IDs
});

const assignVillaSchema = z.object({
  villaId: z.string().cuid(),
  notes: z.string().optional(),
});

const updateStaffSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  type: z.nativeEnum(StaffType).optional(),
  phone: z.string().min(10).max(15).optional(),
  address: z.string().optional(),
  idProof: z.string().optional(),
  photo: z.string().optional(),
  isActive: z.boolean().optional(),
});

router.use(requireAuth);

// List staff (admin sees all, resident sees their villa's staff)
router.get("/", async (req, res, next) => {
  try {
    const { societyId, villaId, role } = req.auth!;

    const whereClause: any = {
      societyId,
    };

    const staff = await prisma.staff.findMany({
      where: whereClause,
      include: {
        assignments: {
          where: {
            isActive: true,
            ...(role === UserRole.RESIDENT && villaId ? { villaId } : {}),
          },
          include: {
            villa: {
              select: {
                villaNumber: true,
                block: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Filter staff based on role
    const filteredStaff = role === UserRole.RESIDENT && villaId
      ? staff.filter(s => s.assignments.length > 0)
      : staff;

    return res.json({ staff: filteredStaff });
  } catch (error) {
    next(error);
  }
});

// Get staff details
router.get("/:id", async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    const staff = await prisma.staff.findFirst({
      where: { id, societyId },
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
          orderBy: { startDate: "desc" },
        },
      },
    });

    if (!staff) {
      return res.status(404).json({ message: "Staff not found" });
    }

    return res.json({ staff });
  } catch (error) {
    next(error);
  }
});

// Create staff with multiple villa assignments
router.post(
  "/",
  requireRole(UserRole.ADMIN, UserRole.RESIDENT),
  validateBody(createStaffSchema),
  async (req, res, next) => {
  try {
    const { societyId, role, villaId } = req.auth!;
    const body = req.body as z.infer<typeof createStaffSchema>;

    // Residents can only add staff to their own villa
    if (role === UserRole.RESIDENT) {
      if (!villaId) {
        return res.status(403).json({ message: "Villa not assigned to your account" });
      }
      if (!body.villaIds.includes(villaId)) {
        return res.status(403).json({ message: "Can only add staff to your own villa" });
      }
    }

    // Verify all villas belong to the society
    const villas = await prisma.villa.findMany({
      where: {
        id: { in: body.villaIds },
        societyId,
      },
    });

    if (villas.length !== body.villaIds.length) {
      return res.status(404).json({ message: "One or more villas not found" });
    }

    // Create staff and assignments in a transaction
    const staff = await prisma.staff.create({
      data: {
        societyId,
        name: body.name,
        type: body.type,
        phone: body.phone,
        address: body.address,
        idProof: body.idProof,
        photo: body.photo,
        assignments: {
          create: body.villaIds.map((villaId) => ({
            villaId,
            isActive: true,
          })),
        },
      },
      include: {
        assignments: {
          include: {
            villa: {
              select: {
                villaNumber: true,
                block: true,
              },
            },
          },
        },
      },
    });

    return res.status(201).json({ staff });
  } catch (error) {
    next(error);
  }
  }
);

// Assign staff to additional villa
router.post(
  "/:id/assign",
  requireRole(UserRole.ADMIN, UserRole.RESIDENT),
  validateBody(assignVillaSchema),
  async (req, res, next) => {
  try {
    const { societyId, role, villaId: userVillaId } = req.auth!;
    const { id } = req.params;
    const { villaId, notes } = req.body as z.infer<typeof assignVillaSchema>;

    // Verify staff exists
    const staff = await prisma.staff.findFirst({
      where: { id, societyId },
    });

    if (!staff) {
      return res.status(404).json({ message: "Staff not found" });
    }

    // Residents can only assign to their own villa
    if (role === UserRole.RESIDENT) {
      if (!userVillaId || villaId !== userVillaId) {
        return res.status(403).json({ message: "Can only assign staff to your own villa" });
      }
    }

    // Verify villa exists
    const villa = await prisma.villa.findFirst({
      where: { id: villaId, societyId },
    });

    if (!villa) {
      return res.status(404).json({ message: "Villa not found" });
    }

    // Check if already assigned
    const existingAssignment = await prisma.staffAssignment.findFirst({
      where: {
        staffId: id,
        villaId,
        isActive: true,
      },
    });

    if (existingAssignment) {
      return res.status(400).json({ message: "Staff already assigned to this villa" });
    }

    // Create assignment
    const assignment = await prisma.staffAssignment.create({
      data: {
        staffId: id,
        villaId,
        notes,
        isActive: true,
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

    return res.status(201).json({ assignment });
  } catch (error) {
    next(error);
  }
  }
);

// Remove staff from villa (deactivate assignment)
router.delete(
  "/:id/assignments/:assignmentId",
  requireRole(UserRole.ADMIN, UserRole.RESIDENT),
  async (req, res, next) => {
  try {
    const { societyId, role, villaId } = req.auth!;
    const { id, assignmentId } = req.params;

    // Verify staff and assignment
    const assignment = await prisma.staffAssignment.findFirst({
      where: {
        id: assignmentId,
        staffId: id,
      },
      include: {
        staff: true,
      },
    });

    if (!assignment || assignment.staff.societyId !== societyId) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    // Residents can only remove from their own villa
    if (role === UserRole.RESIDENT) {
      if (!villaId || assignment.villaId !== villaId) {
        return res.status(403).json({ message: "Can only remove staff from your own villa" });
      }
    }

    // Deactivate assignment
    await prisma.staffAssignment.update({
      where: { id: assignmentId },
      data: {
        isActive: false,
        endDate: new Date(),
      },
    });

    return res.json({ message: "Staff removed from villa" });
  } catch (error) {
    next(error);
  }
  }
);

// Update staff details
router.patch("/:id", validateBody(updateStaffSchema), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;
    const body = req.body as z.infer<typeof updateStaffSchema>;

    const staff = await prisma.staff.updateMany({
      where: { id, societyId },
      data: body,
    });

    if (staff.count === 0) {
      return res.status(404).json({ message: "Staff not found" });
    }

    const updatedStaff = await prisma.staff.findUnique({
      where: { id },
      include: {
        assignments: {
          where: { isActive: true },
          include: {
            villa: {
              select: {
                villaNumber: true,
                block: true,
              },
            },
          },
        },
      },
    });

    return res.json({ staff: updatedStaff });
  } catch (error) {
    next(error);
  }
});

// Delete/deactivate staff completely
router.delete("/:id", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const { id } = req.params;

    const staff = await prisma.staff.updateMany({
      where: { id, societyId },
      data: { isActive: false },
    });

    if (staff.count === 0) {
      return res.status(404).json({ message: "Staff not found" });
    }

    // Deactivate all assignments
    await prisma.staffAssignment.updateMany({
      where: { staffId: id, isActive: true },
      data: { isActive: false, endDate: new Date() },
    });

    return res.json({ message: "Staff deactivated" });
  } catch (error) {
    next(error);
  }
});

export default router;
