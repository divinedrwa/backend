import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { getPagination, paginationMeta } from "../../lib/pagination";
import { prisma } from "../../lib/prisma";
import { profileImageMemory } from "../../lib/profileImageUpload";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { ComplaintPriority, ComplaintStatus, UserRole } from "@prisma/client";
import { enrichComplaintForResident } from "../../lib/complaintSlaTimeline";
import { isCloudinaryConfigured } from "../../services/cloudinaryProfile";
import { uploadExpenseAttachmentBuffer } from "../../services/cloudinaryExpenseAttachment";
import { logger } from "../../lib/logger";

const router = Router();

router.use(requireAuth);

const createComplaintSchema = z.object({
  title: z.string().trim().min(5),
  description: z.string().trim().min(10),
  category: z.string().trim().optional(),
  priority: z.nativeEnum(ComplaintPriority).optional(),
});

const updateComplaintSchema = z.object({
  title: z.string().trim().min(5).optional(),
  description: z.string().trim().min(10).optional(),
});

function complaintCreateUpload(req: Request, res: Response, next: NextFunction) {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) {
    return profileImageMemory.single("image")(req, res, next);
  }
  next();
}

function parseComplaintCreateBody(req: Request): z.infer<typeof createComplaintSchema> {
  const raw = req.body as Record<string, unknown>;
  return createComplaintSchema.parse({
    title: raw.title,
    description: raw.description,
    category: raw.category,
    priority: raw.priority,
  });
}

// GET /api/residents/my-complaints - Get my complaints
router.get("/my-complaints", requireRole(UserRole.RESIDENT, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { status } = req.query;

    const pagination = getPagination(req);
    const where = {
      residentId: userId,
      societyId,
      ...(status && { status: status as ComplaintStatus }),
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
      complaints: complaints.map(enrichComplaintForResident),
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

    return res.json({ complaint: enrichComplaintForResident(complaint) });
  } catch (error) {
    next(error);
  }
});

// POST /api/residents/complaints - Create complaint (JSON or multipart with optional image)
router.post(
  "/complaints",
  requireRole(UserRole.RESIDENT, UserRole.ADMIN),
  complaintCreateUpload,
  async (req, res, next) => {
    try {
      const { userId, societyId } = req.auth!;
      const { title, description, category, priority } = parseComplaintCreateBody(req);

      const user = await prisma.user.findFirst({
        where: { id: userId, societyId },
        select: { villaId: true },
      });

      if (!user || !user.villaId) {
        return res.status(400).json({ message: "Villa not assigned" });
      }

      let photoUrl: string | undefined;
      const file = req.file as Express.Multer.File | undefined;
      if (file?.buffer?.length) {
        if (!isCloudinaryConfigured()) {
          return res.status(503).json({
            message:
              "Photo upload is not configured. Submit without a photo or ask your society admin.",
          });
        }
        try {
          const uploaded = await uploadExpenseAttachmentBuffer(
            file.buffer,
            societyId,
            `complaint-${Date.now()}`,
            file.mimetype,
          );
          photoUrl = uploaded.secureUrl;
        } catch (err) {
          logger.error({ err }, "[complaint] photo upload failed");
          return res.status(502).json({ message: "Could not upload photo. Try again." });
        }
      }

      const prio = priority ?? ComplaintPriority.MEDIUM;
      const now = new Date();
      const SLA_HOURS: Record<ComplaintPriority, number> = {
        LOW: 168,
        MEDIUM: 72,
        HIGH: 24,
        URGENT: 6,
      };
      const complaint = await prisma.complaint.create({
        data: {
          societyId,
          residentId: userId,
          villaId: user.villaId,
          title,
          description,
          category: category || "General",
          priority: prio,
          photoUrl,
          slaDeadline: new Date(now.getTime() + SLA_HOURS[prio] * 3600_000),
          status: "OPEN",
        },
      });

      return res.status(201).json({
        message: "Complaint submitted successfully",
        complaint: enrichComplaintForResident(complaint),
      });
    } catch (error) {
      next(error);
    }
  },
);

// PATCH /api/residents/complaints/:id - Update my complaint
router.patch("/complaints/:id", requireRole(UserRole.RESIDENT, UserRole.ADMIN), validateBody(updateComplaintSchema), async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;
    const { title, description } = req.body;

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
      complaint: enrichComplaintForResident(updated),
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
