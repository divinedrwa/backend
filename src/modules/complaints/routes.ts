import { ComplaintStatus, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
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
    const complaints = await prisma.complaint.findMany({
      where: { societyId: req.auth!.societyId },
      include: {
        villa: {
          select: {
            villaNumber: true,
            block: true,
            ownerName: true
          }
        }
      },
      orderBy: { createdAt: "desc" }
    });
    return res.json({ complaints });
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
