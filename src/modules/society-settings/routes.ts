import { Router } from "express";
import { z } from "zod";
import { SocietyStatus, UserRole, VisitorMultiVillaApprovalMode } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { upiQrImageMemory } from "../../lib/upiQrUpload";
import { uploadUpiQrImageBuffer } from "../../services/cloudinaryUpiQr";

const router = Router();

router.use(requireAuth);

const patchSocietySchema = z
  .object({
    visitorMultiVillaApprovalMode: z.nativeEnum(VisitorMultiVillaApprovalMode).optional(),
    visitorApprovalRequired: z.boolean().optional(),
    guardCanApproveVisitors: z.boolean().optional(),
    status: z.nativeEnum(SocietyStatus).optional(),
    upiVpa: z.string().min(3).regex(/@/, "Must contain @").nullable().optional(),
    upiQrCodeUrl: z.string().url().nullable().optional(),
  })
  .refine(
    (body) =>
      body.visitorMultiVillaApprovalMode != null ||
      body.visitorApprovalRequired != null ||
      body.guardCanApproveVisitors != null ||
      body.status != null ||
      body.upiVpa !== undefined ||
      body.upiQrCodeUrl !== undefined,
    { message: "Send at least one field to update" },
  );

/**
 * GET /api/society-settings — gate rules + lifecycle (ADMIN).
 */
router.get("/", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const society = await prisma.society.findUnique({
      where: { id: societyId },
      select: {
        id: true,
        name: true,
        status: true,
        visitorMultiVillaApprovalMode: true,
        visitorApprovalRequired: true,
        guardCanApproveVisitors: true,
        upiVpa: true,
        upiQrCodeUrl: true,
      },
    });
    if (!society) {
      return res.status(404).json({ message: "Society not found" });
    }
    return res.json({ society });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/society-settings — update visitor rules and/or ACTIVE/INACTIVE.
 */
router.patch(
  "/",
  requireRole(UserRole.ADMIN),
  validateBody(patchSocietySchema),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const body = req.body as z.infer<typeof patchSocietySchema>;

      const data: {
        visitorMultiVillaApprovalMode?: VisitorMultiVillaApprovalMode;
        visitorApprovalRequired?: boolean;
        guardCanApproveVisitors?: boolean;
        status?: SocietyStatus;
        upiVpa?: string | null;
        upiQrCodeUrl?: string | null;
      } = {};

      if (body.visitorMultiVillaApprovalMode != null) {
        data.visitorMultiVillaApprovalMode = body.visitorMultiVillaApprovalMode;
      }
      if (body.visitorApprovalRequired != null) {
        data.visitorApprovalRequired = body.visitorApprovalRequired;
      }
      if (body.guardCanApproveVisitors != null) {
        data.guardCanApproveVisitors = body.guardCanApproveVisitors;
      }
      if (body.status != null) {
        data.status = body.status;
      }
      if (body.upiVpa !== undefined) {
        data.upiVpa = body.upiVpa;
      }
      if (body.upiQrCodeUrl !== undefined) {
        data.upiQrCodeUrl = body.upiQrCodeUrl;
      }

      const updated = await prisma.society.updateMany({
        where: { id: societyId },
        data,
      });

      if (updated.count === 0) {
        return res.status(404).json({ message: "Society not found" });
      }

      const society = await prisma.society.findUnique({
        where: { id: societyId },
        select: {
          id: true,
          name: true,
          status: true,
          visitorMultiVillaApprovalMode: true,
          visitorApprovalRequired: true,
          guardCanApproveVisitors: true,
          upiVpa: true,
          upiQrCodeUrl: true,
        },
      });

      return res.json({
        message: "Society settings updated",
        society,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/society-settings/upload-qr — upload a custom UPI QR code image (ADMIN).
 */
router.post(
  "/upload-qr",
  requireRole(UserRole.ADMIN),
  upiQrImageMemory.single("qrImage"),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      if (!req.file) {
        return res.status(400).json({ message: "No image file provided" });
      }

      const url = await uploadUpiQrImageBuffer(req.file.buffer, societyId);

      await prisma.society.updateMany({
        where: { id: societyId },
        data: { upiQrCodeUrl: url },
      });

      return res.json({ url });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * DELETE /api/society-settings/qr-code — remove the custom UPI QR code image (ADMIN).
 */
router.delete(
  "/qr-code",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      await prisma.society.updateMany({
        where: { id: societyId },
        data: { upiQrCodeUrl: null },
      });
      return res.json({ message: "QR code removed" });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
