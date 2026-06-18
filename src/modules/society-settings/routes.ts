import { Router } from "express";
import { z } from "zod";
import { PaymentMethodType, UserRole, VisitorMultiVillaApprovalMode } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { upiQrImageMemory } from "../../lib/upiQrUpload";
import { uploadUpiQrImageBuffer } from "../../services/cloudinaryUpiQr";
import { letterheadImageMemory } from "../../lib/letterheadUpload";
import { uploadLetterheadImageBuffer } from "../../services/cloudinaryLetterhead";

const router = Router();

router.use(requireAuth);

const patchSocietySchema = z
  .object({
    visitorMultiVillaApprovalMode: z.nativeEnum(VisitorMultiVillaApprovalMode).optional(),
    visitorApprovalRequired: z.boolean().optional(),
    guardCanApproveVisitors: z.boolean().optional(),
    upiVpa: z.string().trim().min(3).regex(/@/, "Must contain @").nullable().optional(),
    upiQrCodeUrl: z.string().url().nullable().optional(),
  })
  .refine(
    (body) =>
      body.visitorMultiVillaApprovalMode != null ||
      body.visitorApprovalRequired != null ||
      body.guardCanApproveVisitors != null ||
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
        letterheadUrl: true,
        lateFeePercentage: true,
        lateFeeFixedAmount: true,
        maintenanceGracePeriodDays: true,
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

      // Dual-write: sync UPI changes to PaymentMethod table
      if (body.upiVpa !== undefined) {
        const existingVpa = await prisma.paymentMethod.findFirst({
          where: { societyId, type: PaymentMethodType.UPI_VPA },
        });
        if (body.upiVpa) {
          if (existingVpa) {
            await prisma.paymentMethod.update({
              where: { id: existingVpa.id },
              data: { config: { vpa: body.upiVpa }, isEnabled: true },
            });
          } else {
            await prisma.paymentMethod.create({
              data: {
                societyId,
                type: PaymentMethodType.UPI_VPA,
                displayName: "UPI",
                config: { vpa: body.upiVpa },
                sortOrder: 10,
              },
            });
          }
        } else if (existingVpa) {
          // VPA cleared — disable PaymentMethod
          await prisma.paymentMethod.update({
            where: { id: existingVpa.id },
            data: { isEnabled: false, config: { vpa: null } },
          });
        }
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
          letterheadUrl: true,
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
 * PATCH /api/society-settings/late-fee — configure late fee automation (ADMIN).
 */
const lateFeePatchSchema = z.object({
  lateFeePercentage: z.number().min(0).max(100).optional(),
  lateFeeFixedAmount: z.number().min(0).optional(),
  maintenanceGracePeriodDays: z.number().int().min(0).max(90).optional(),
}).refine(
  (body) =>
    body.lateFeePercentage !== undefined ||
    body.lateFeeFixedAmount !== undefined ||
    body.maintenanceGracePeriodDays !== undefined,
  { message: "Send at least one field to update" },
);

router.patch(
  "/late-fee",
  requireRole(UserRole.ADMIN),
  validateBody(lateFeePatchSchema),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const body = req.body as z.infer<typeof lateFeePatchSchema>;

      const data: Record<string, unknown> = {};
      if (body.lateFeePercentage !== undefined) data.lateFeePercentage = body.lateFeePercentage;
      if (body.lateFeeFixedAmount !== undefined) data.lateFeeFixedAmount = body.lateFeeFixedAmount;
      if (body.maintenanceGracePeriodDays !== undefined) data.maintenanceGracePeriodDays = body.maintenanceGracePeriodDays;

      await prisma.society.updateMany({ where: { id: societyId }, data });

      const society = await prisma.society.findUnique({
        where: { id: societyId },
        select: {
          lateFeePercentage: true,
          lateFeeFixedAmount: true,
          maintenanceGracePeriodDays: true,
        },
      });

      return res.json({ message: "Late fee settings updated", lateFee: society });
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

      // Dual-write: sync to PaymentMethod table
      const existingQr = await prisma.paymentMethod.findFirst({
        where: { societyId, type: PaymentMethodType.UPI_QR },
      });
      if (existingQr) {
        await prisma.paymentMethod.update({
          where: { id: existingQr.id },
          data: { config: { qrCodeUrl: url }, isEnabled: true },
        });
      } else {
        await prisma.paymentMethod.create({
          data: {
            societyId,
            type: PaymentMethodType.UPI_QR,
            displayName: "UPI QR Code",
            config: { qrCodeUrl: url },
            sortOrder: 11,
          },
        });
      }

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

      // Dual-write: disable QR in PaymentMethod table
      const existingQr = await prisma.paymentMethod.findFirst({
        where: { societyId, type: PaymentMethodType.UPI_QR },
      });
      if (existingQr) {
        await prisma.paymentMethod.update({
          where: { id: existingQr.id },
          data: { isEnabled: false, config: { qrCodeUrl: null } },
        });
      }

      return res.json({ message: "QR code removed" });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/society-settings/upload-letterhead — upload the society letterhead image (ADMIN).
 * Used as the branding background for generated documents (e.g. maintenance invoices).
 */
router.post(
  "/upload-letterhead",
  requireRole(UserRole.ADMIN),
  letterheadImageMemory.single("letterhead"),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      if (!req.file) {
        return res.status(400).json({ message: "No image file provided" });
      }

      const url = await uploadLetterheadImageBuffer(req.file.buffer, societyId);

      await prisma.society.updateMany({
        where: { id: societyId },
        data: { letterheadUrl: url },
      });

      return res.json({ url });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * DELETE /api/society-settings/letterhead — remove the society letterhead image (ADMIN).
 */
router.delete(
  "/letterhead",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      await prisma.society.updateMany({
        where: { id: societyId },
        data: { letterheadUrl: null },
      });
      return res.json({ message: "Letterhead removed" });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
