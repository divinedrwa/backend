import { ComplaintStatus, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { notifyResidentsComplaintStatusChanged } from "../../services/complaintStatusNotification.service";

const router = Router();

const createComplaintSchema = z.object({
  villaId: z.string().cuid(),
  title: z.string().min(3).max(200),
  description: z.string().min(10)
});

const updateComplaintSchema = z.object({
  status: z.nativeEnum(ComplaintStatus)
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

      const complaint = await prisma.complaint.create({
        data: {
          societyId: req.auth!.societyId,
          villaId: body.villaId,
          residentId: req.auth!.userId,
          title: body.title,
          description: body.description
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
      const { status } = req.body as z.infer<typeof updateComplaintSchema>;
      const { id } = req.params;
      const societyId = req.auth!.societyId;

      const existing = await prisma.complaint.findFirst({
        where: { id, societyId },
      });

      if (!existing) {
        return res.status(404).json({ message: "Complaint not found" });
      }

      if (existing.status !== status) {
        await prisma.complaint.update({
          where: { id },
          data: {
            status,
            ...(status === "RESOLVED" && !existing.resolvedAt ? { resolvedAt: new Date() } : {}),
          },
        });

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

      return res.json({ message: "Complaint status updated" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
