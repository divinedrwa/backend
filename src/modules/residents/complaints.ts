import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { UserRole } from "@prisma/client";

const router = Router();

router.use(requireAuth);

// Validation schemas
const createComplaintSchema = z.object({
  title: z.string().min(5),
  description: z.string().min(10),
  category: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
});

const updateComplaintSchema = z.object({
  title: z.string().min(5).optional(),
  description: z.string().min(10).optional(),
});

// GET /api/residents/my-complaints - Get my complaints
router.get("/my-complaints", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { status } = req.query;

    const pagination = getPagination(req);
    const where = {
      residentId: userId,
      societyId,
      ...(status && { status: status as any }),
    };
    const [complaints, total] = await Promise.all([
      prisma.complaint.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.complaint.count({ where }),
    ]);

    const open = complaints.filter((c) => c.status === "OPEN");
    const resolved = complaints.filter((c) => c.status === "RESOLVED");

    return res.json({
      complaints,
      summary: {
        total,
        open: open.length,
        inProgress: complaints.filter((c) => c.status === "IN_PROGRESS").length,
        resolved: resolved.length,
      },
      ...paginationMeta(total, complaints.length, pagination),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/residents/complaints/:id - Get complaint details
router.get("/complaints/:id", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;

    const complaint = await prisma.complaint.findFirst({
      where: {
        id,
        residentId: userId,
        societyId,
      },
      include: {
        villa: {
          select: {
            villaNumber: true,
          },
        },
      },
    });

    if (!complaint) {
      return res.status(404).json({ message: "Complaint not found" });
    }

    return res.json({ complaint });
  } catch (error) {
    next(error);
  }
});

// POST /api/residents/complaints - Create complaint
router.post("/complaints", requireRole(UserRole.RESIDENT, UserRole.ADMIN), validateBody(createComplaintSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { title, description, category, priority } = req.body;

    // Get user's villa
    const user = await prisma.user.findFirst({
      where: { id: userId, societyId },
      select: { villaId: true },
    });

    if (!user || !user.villaId) {
      return res.status(400).json({ message: "Villa not assigned" });
    }

    const complaint = await prisma.complaint.create({
      data: {
        societyId,
        residentId: userId,
        villaId: user.villaId,
        title,
        description,
        category: category || "General",
        // priority field does not exist in schema, removed
        status: "OPEN",
      },
    });

    return res.status(201).json({
      message: "Complaint submitted successfully",
      complaint,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/residents/complaints/:id - Update my complaint
router.patch("/complaints/:id", requireRole(UserRole.RESIDENT, UserRole.ADMIN), validateBody(updateComplaintSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;
    const { title, description } = req.body;

    // Verify ownership
    const existing = await prisma.complaint.findFirst({
      where: {
        id,
        residentId: userId,
        societyId,
      },
    });

    if (!existing) {
      return res.status(404).json({ message: "Complaint not found" });
    }

    // Only allow updates if status is OPEN
    if (existing.status !== "OPEN") {
      return res.status(400).json({ message: "Cannot update complaint after it's being processed" });
    }

    const updated = await prisma.complaint.update({
      where: { id },
      data: {
        ...(title && { title }),
        ...(description && { description }),
      },
    });

    return res.json({
      message: "Complaint updated successfully",
      complaint: updated,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/residents/complaints/:id - Delete my complaint
router.delete("/complaints/:id", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;

    // Verify ownership
    const existing = await prisma.complaint.findFirst({
      where: {
        id,
        residentId: userId,
        societyId,
      },
    });

    if (!existing) {
      return res.status(404).json({ message: "Complaint not found" });
    }

    // Only allow deletion if status is OPEN
    if (existing.status !== "OPEN") {
      return res.status(400).json({ message: "Cannot delete complaint after it's being processed" });
    }

    await prisma.complaint.delete({ where: { id } });

    return res.json({ message: "Complaint deleted successfully" });
  } catch (error) {
    next(error);
  }
});

export default router;
