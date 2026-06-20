import { ComplaintPriority, ComplaintStatus, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import {
  assertComplaintStatusTransition,
  computeComplaintSlaDeadline,
} from "../../services/complaintLifecycle.service";
import { notifyResidentsComplaintStatusChanged } from "../../services/complaintStatusNotification.service";

const router = Router();

const createComplaintSchema = z.object({
  villaId: z.string().cuid(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10),
  category: z.string().trim().max(100).optional(),
  priority: z.nativeEnum(ComplaintPriority).optional(),
});

const updateComplaintSchema = z.object({
  status: z.nativeEnum(ComplaintStatus),
  priority: z.nativeEnum(ComplaintPriority).optional(),
});

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const pagination = getPagination(req);
    const where = { societyId: req.auth!.societyId };
    const [complaints, total, openCount] = await Promise.all([
      prisma.complaint.findMany({
        where,
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
        take: pagination.take,
        skip: pagination.skip,
      }),
      prisma.complaint.count({ where }),
      prisma.complaint.count({ where: { ...where, status: { not: "CLOSED" } } }),
    ]);
    // Domain key kept for backwards compatibility with existing UI; new
    // pagination metadata lives alongside it.
    return res.json({
      complaints,
      openCount,
      ...paginationMeta(total, complaints.length, pagination),
    });
  } catch (error) {
    next(error);
  }
});

router.post(
  "/",
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  validateBody(createComplaintSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createComplaintSchema>;
      
      const villa = await prisma.villa.findFirst({
        where: {
          id: body.villaId,
          societyId: req.auth!.societyId
        }
      });

      if (!villa) {
        return res.status(404).json({ message: "Villa not found" });
      }

      const priority = body.priority ?? ComplaintPriority.MEDIUM;
      const complaint = await prisma.complaint.create({
        data: {
          societyId: req.auth!.societyId,
          villaId: body.villaId,
          residentId: req.auth!.userId,
          title: body.title,
          description: body.description,
          category: body.category?.trim() || "General",
          priority,
          slaDeadline: computeComplaintSlaDeadline(priority),
        },
        include: {
          villa: {
            select: {
              villaNumber: true,
              block: true,
              ownerName: true
            }
          }
        }
      });
      return res.status(201).json({ complaint });
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  "/:id/status",
  requireRole(UserRole.ADMIN),
  validateBody(updateComplaintSchema),
  async (req, res, next) => {
    try {
      const { status, priority } = req.body as z.infer<typeof updateComplaintSchema>;
      const { id } = req.params;
      const societyId = req.auth!.societyId;

      const existing = await prisma.complaint.findFirst({
        where: { id, societyId },
      });

      if (!existing) {
        return res.status(404).json({ message: "Complaint not found" });
      }

      try {
        assertComplaintStatusTransition(existing.status, status);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid status transition";
        return res.status(400).json({ message });
      }

      const data: Record<string, unknown> = {};
      if (status !== existing.status) data.status = status;
      if (status === "RESOLVED" && !existing.resolvedAt) data.resolvedAt = new Date();
      if (priority && priority !== existing.priority) {
        data.priority = priority;
        data.slaDeadline = computeComplaintSlaDeadline(priority, existing.createdAt);
      }

      if (Object.keys(data).length > 0) {
        await prisma.complaint.update({ where: { id }, data });
      }

      if (existing.status !== status) {
        void notifyResidentsComplaintStatusChanged({
          complaintId: id,
          title: existing.title,
          villaId: existing.villaId,
          societyId,
          residentId: existing.residentId,
          previousStatus: existing.status,
          newStatus: status,
        });
      }

      return res.json({ message: "Complaint updated" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
