import { DocumentCategory, UserRole } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";

const router = Router();

const createDocumentSchema = z.object({
  title: z.string().min(3).max(200),
  category: z.nativeEnum(DocumentCategory),
  description: z.string().optional(),
  fileUrl: z.string().url()
});

const updateDocumentSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  category: z.nativeEnum(DocumentCategory).optional(),
  description: z.string().optional()
});

router.use(requireAuth);

// List documents
router.get("/", async (req, res, next) => {
  try {
    const documents = await prisma.document.findMany({
      where: { societyId: req.auth!.societyId },
      orderBy: { createdAt: "desc" }
    });
    return res.json({ documents });
  } catch (error) {
    next(error);
  }
});

// Upload document (admin only)
router.post(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(createDocumentSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof createDocumentSchema>;

      const document = await prisma.document.create({
        data: {
          societyId: req.auth!.societyId,
          title: body.title,
          category: body.category,
          description: body.description,
          fileUrl: body.fileUrl,
          uploadedBy: req.auth!.userId
        }
      });

      return res.status(201).json({ document });
    } catch (error) {
      next(error);
    }
  }
);

// Update document
router.patch(
  "/:id",
  requireRole(UserRole.ADMIN),
  validateBody(updateDocumentSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof updateDocumentSchema>;
      const { id } = req.params;

      const document = await prisma.document.updateMany({
        where: {
          id,
          societyId: req.auth!.societyId
        },
        data: body
      });

      if (document.count === 0) {
        return res.status(404).json({ message: "Document not found" });
      }

      return res.json({ message: "Document updated" });
    } catch (error) {
      next(error);
    }
  }
);

// Delete document
router.delete(
  "/:id",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const document = await prisma.document.deleteMany({
        where: {
          id,
          societyId: req.auth!.societyId
        }
      });

      if (document.count === 0) {
        return res.status(404).json({ message: "Document not found" });
      }

      return res.json({ message: "Document deleted" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
