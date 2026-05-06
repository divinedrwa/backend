import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { UserRole } from "@prisma/client";

const router = Router();

router.use(requireAuth);

// Validation schema
const addStaffSchema = z.object({
  name: z.string().min(2),
  type: z.enum(["COOK", "MAID", "DRIVER", "GARDENER", "OTHER"]),
  phone: z.string().min(10),
  address: z.string().optional(),
  idProof: z.string().optional(),
});

// GET /api/residents/my-staff - Get my domestic staff
router.get("/my-staff", requireRole(UserRole.RESIDENT), async (req, res, next) => {
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

    // Get staff assigned to user's villa
    const assignments = await prisma.staffAssignment.findMany({
      where: {
        villaId: user.villaId,
        isActive: true,
      },
      include: {
        staff: {
          select: {
            id: true,
            name: true,
            type: true,
            phone: true,
            address: true,
            isActive: true,
            createdAt: true,
          },
        },
      },
      orderBy: { startDate: "desc" },
    });

    const staff = assignments.map((a) => ({
      ...a.staff,
      assignmentId: a.id,
      startDate: a.startDate,
      notes: a.notes,
    }));

    // Group by type
    const byType = staff.reduce((acc: any, s) => {
      acc[s.type] = (acc[s.type] || 0) + 1;
      return acc;
    }, {});

    return res.json({
      staff,
      summary: {
        total: staff.length,
        byType,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/residents/add-staff - Add domestic staff
router.post("/add-staff", requireRole(UserRole.RESIDENT), validateBody(addStaffSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { name, type, phone, address, idProof } = req.body;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(400).json({ message: "Villa not assigned" });
    }

    // Check if staff already exists
    let staff = await prisma.staff.findFirst({
      where: {
        societyId,
        phone,
        name,
      },
    });

    // Create staff if doesn't exist
    if (!staff) {
      staff = await prisma.staff.create({
        data: {
          societyId,
          name,
          type,
          phone,
          address,
          idProof,
          isActive: true,
        },
      });
    }

    // Check if already assigned
    const existingAssignment = await prisma.staffAssignment.findFirst({
      where: {
        staffId: staff.id,
        villaId: user.villaId,
        isActive: true,
      },
    });

    if (existingAssignment) {
      return res.status(400).json({ message: "Staff already assigned to your villa" });
    }

    // Create assignment
    const assignment = await prisma.staffAssignment.create({
      data: {
        staffId: staff.id,
        villaId: user.villaId,
        startDate: new Date(),
        isActive: true,
      },
      include: {
        staff: true,
      },
    });

    return res.status(201).json({
      message: "Staff added successfully",
      assignment,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/residents/staff/:assignmentId - Remove staff
router.delete("/staff/:assignmentId", requireRole(UserRole.RESIDENT), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { assignmentId } = req.params;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(404).json({ message: "Villa not assigned" });
    }

    // Verify ownership
    const assignment = await prisma.staffAssignment.findFirst({
      where: {
        id: assignmentId,
        villaId: user.villaId,
      },
    });

    if (!assignment) {
      return res.status(404).json({ message: "Staff assignment not found" });
    }

    // Soft delete by marking inactive and setting end date
    await prisma.staffAssignment.update({
      where: { id: assignmentId },
      data: {
        isActive: false,
        endDate: new Date(),
      },
    });

    return res.json({ message: "Staff removed successfully" });
  } catch (error) {
    next(error);
  }
});

export default router;
