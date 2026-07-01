import { Router } from "express";
import { z } from "zod";
import { PaymentMethodType, Prisma, UserRole, VisitorMultiVillaApprovalMode } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { upiQrImageMemory } from "../../lib/upiQrUpload";
import { processUpiQrImageUpload } from "../payment-methods/upiQrUpload.service";
import {
  enrichUpiVpaConfig,
  validateUpiVpa,
} from "../../lib/validateUpiVpa";
import { letterheadImageMemory } from "../../lib/letterheadUpload";
import { uploadLetterheadImageBuffer } from "../../services/cloudinaryLetterhead";
import { brandingImageMemory } from "../../lib/brandingImageUpload";
import { uploadBrandingImageBuffer } from "../../services/cloudinaryBranding";
import { cacheMiddleware, invalidateSocietyCache } from "../../middlewares/cache";
import {
  isMissingColumnError,
  isMissingThemeColorsColumn,
  societyThemeColorsColumnExists,
} from "../../lib/schemaChecks";

const router = Router();

router.use(requireAuth);

async function bustSocietySettingsCache(societyId: string) {
  await invalidateSocietyCache(societyId);
}

const societySettingsSelectBase = {
  id: true,
  name: true,
  status: true,
  visitorMultiVillaApprovalMode: true,
  visitorApprovalRequired: true,
  guardCanApproveVisitors: true,
  upiVpa: true,
  upiQrCodeUrl: true,
  letterheadUrl: true,
  signatureUrl: true,
  stampUrl: true,
  lateFeePercentage: true,
  lateFeeFixedAmount: true,
  maintenanceGracePeriodDays: true,
} as const;

async function fetchSocietySettings(societyId: string) {
  try {
    return await prisma.society.findUnique({
      where: { id: societyId },
      select: { ...societySettingsSelectBase, themeColors: true, splashUrl: true },
    });
  } catch (error) {
    if (!isMissingColumnError(error)) throw error;
    const society = await prisma.society.findUnique({
      where: { id: societyId },
      select: societySettingsSelectBase,
    });
    if (!society) return null;
    return { ...society, themeColors: null, splashUrl: null };
  }
}

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Must be a 6-digit hex color");
const rgbaColor = z
  .string()
  .regex(
    /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(\s*,\s*[\d.]+)?\s*\)$/i,
    "Must be rgb() or rgba()",
  );
const themeColorValue = z.union([hexColor, rgbaColor]);

const themeColorsSchema = z
  .object({
    primaryColor: hexColor,
    primaryHover: hexColor,
    primaryLight: hexColor,
    primaryContainer: hexColor,
    secondaryColor: hexColor,
    accentColor: hexColor,
    gradientStart: hexColor,
    gradientMiddle: hexColor,
    gradientEnd: hexColor,
    buttonBg: hexColor,
    buttonText: hexColor,
    secondaryButtonBg: hexColor,
    secondaryButtonText: hexColor,
    headingColor: hexColor,
    bodyTextColor: hexColor,
    mutedTextColor: hexColor,
    backgroundColor: hexColor,
    cardColor: hexColor,
    fieldBg: themeColorValue,
    fieldText: hexColor,
    sidebarBg: hexColor,
    sidebarActiveColor: hexColor,
    borderColor: hexColor,
    iconColor: hexColor,
    iconBg: hexColor,
    warningColor: hexColor,
    errorColor: hexColor,
  })
  .partial();

const patchSocietySchema = z
  .object({
    visitorMultiVillaApprovalMode: z.nativeEnum(VisitorMultiVillaApprovalMode).optional(),
    visitorApprovalRequired: z.boolean().optional(),
    guardCanApproveVisitors: z.boolean().optional(),
    upiVpa: z
      .string()
      .trim()
      .min(3)
      .regex(/@/, "Must contain @")
      .nullable()
      .optional(),
    upiQrCodeUrl: z.string().url().nullable().optional(),
    themeColors: themeColorsSchema.nullable().optional(),
  })
  .refine(
    (body) =>
      body.visitorMultiVillaApprovalMode != null ||
      body.visitorApprovalRequired != null ||
      body.guardCanApproveVisitors != null ||
      body.upiVpa !== undefined ||
      body.upiQrCodeUrl !== undefined ||
      body.themeColors !== undefined,
    { message: "Send at least one field to update" },
  );

/**
 * GET /api/society-settings — gate rules + lifecycle (ADMIN).
 */
router.get("/", requireRole(UserRole.ADMIN), cacheMiddleware(120), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;
    const society = await fetchSocietySettings(societyId);
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
        themeColors?: Prisma.InputJsonValue | typeof Prisma.DbNull;
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
        if (body.upiVpa) {
          try {
            const validated = validateUpiVpa(body.upiVpa);
            data.upiVpa = validated.vpa;
          } catch (err) {
            const message = err instanceof Error ? err.message : "Invalid UPI VPA";
            return res.status(400).json({ message });
          }
        } else {
          data.upiVpa = null;
        }
      }
      if (body.upiQrCodeUrl !== undefined) {
        data.upiQrCodeUrl = body.upiQrCodeUrl;
      }
      if (body.themeColors !== undefined) {
        const hasColumn = await societyThemeColorsColumnExists();
        if (!hasColumn) {
          return res.status(503).json({
            message:
              'Database schema is out of date (missing Society.themeColors). Run `npm run repair:theme-colors-column` on the API service (or prisma migrate deploy), then restart.',
          });
        }
        data.themeColors = body.themeColors === null ? Prisma.DbNull : body.themeColors;
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
          const vpaConfig = enrichUpiVpaConfig(
            { vpa: data.upiVpa as string },
            existingVpa?.config as Record<string, unknown> | undefined,
          );
          if (existingVpa) {
            await prisma.paymentMethod.update({
              where: { id: existingVpa.id },
              data: { config: vpaConfig as Prisma.InputJsonValue, isEnabled: true },
            });
          } else {
            await prisma.paymentMethod.create({
              data: {
                societyId,
                type: PaymentMethodType.UPI_VPA,
                displayName: "UPI",
                config: vpaConfig as Prisma.InputJsonValue,
                sortOrder: 10,
                isEnabled: true,
              },
            });
          }
        } else if (existingVpa) {
          // VPA cleared — disable PaymentMethod
          await prisma.paymentMethod.update({
            where: { id: existingVpa.id },
            data: { isEnabled: false, config: { vpa: null, vpaValidatedAt: null } },
          });
        }
      }

      const society = await fetchSocietySettings(societyId);

      await bustSocietySettingsCache(societyId);

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

      await bustSocietySettingsCache(societyId);

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

      let uploadResult;
      try {
        uploadResult = await processUpiQrImageUpload(req.file.buffer, societyId);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to read UPI QR code from image";
        return res.status(400).json({ message });
      }

      const { url, config: qrConfig } = uploadResult;

      await prisma.society.updateMany({
        where: { id: societyId },
        data: { upiQrCodeUrl: url, upiVpa: (qrConfig.vpa as string) ?? undefined },
      });

      // Dual-write: sync to PaymentMethod table
      const existingQr = await prisma.paymentMethod.findFirst({
        where: { societyId, type: PaymentMethodType.UPI_QR },
      });
      if (existingQr) {
        await prisma.paymentMethod.update({
          where: { id: existingQr.id },
          data: {
            config: {
              ...(existingQr.config as Record<string, unknown>),
              ...qrConfig,
            } as Prisma.InputJsonValue,
            isEnabled: true,
          },
        });
      } else {
        await prisma.paymentMethod.create({
          data: {
            societyId,
            type: PaymentMethodType.UPI_QR,
            displayName: "UPI QR Code",
            config: qrConfig as Prisma.InputJsonValue,
            sortOrder: 11,
            isEnabled: true,
          },
        });
      }

      await bustSocietySettingsCache(societyId);

      return res.json({ url, validation: uploadResult.validation });
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

      await bustSocietySettingsCache(societyId);

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

      await bustSocietySettingsCache(societyId);

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
      await bustSocietySettingsCache(societyId);
      return res.json({ message: "Letterhead removed" });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/society-settings/upload-signature — upload the authorised-signatory
 * signature image (ADMIN). Printed on generated documents (e.g. invoices).
 */
router.post(
  "/upload-signature",
  requireRole(UserRole.ADMIN),
  brandingImageMemory.single("signature"),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      if (!req.file) {
        return res.status(400).json({ message: "No image file provided" });
      }
      const url = await uploadBrandingImageBuffer(req.file.buffer, societyId, "signature");
      await prisma.society.updateMany({
        where: { id: societyId },
        data: { signatureUrl: url },
      });
      await bustSocietySettingsCache(societyId);
      return res.json({ url });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * DELETE /api/society-settings/signature — remove the signature image (ADMIN).
 */
router.delete(
  "/signature",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      await prisma.society.updateMany({
        where: { id: societyId },
        data: { signatureUrl: null },
      });
      await bustSocietySettingsCache(societyId);
      return res.json({ message: "Signature removed" });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/society-settings/upload-stamp — upload the society stamp/seal image
 * (ADMIN). Printed on generated documents (e.g. invoices).
 */
router.post(
  "/upload-stamp",
  requireRole(UserRole.ADMIN),
  brandingImageMemory.single("stamp"),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      if (!req.file) {
        return res.status(400).json({ message: "No image file provided" });
      }
      const url = await uploadBrandingImageBuffer(req.file.buffer, societyId, "stamp");
      await prisma.society.updateMany({
        where: { id: societyId },
        data: { stampUrl: url },
      });
      await bustSocietySettingsCache(societyId);
      return res.json({ url });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * DELETE /api/society-settings/stamp — remove the stamp image (ADMIN).
 */
router.delete(
  "/stamp",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      await prisma.society.updateMany({
        where: { id: societyId },
        data: { stampUrl: null },
      });
      await bustSocietySettingsCache(societyId);
      return res.json({ message: "Stamp removed" });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/society-settings/upload-splash — upload the mobile app splash image
 * (ADMIN). Shown full-screen under a brand-gradient tint on the app splash.
 */
router.post(
  "/upload-splash",
  requireRole(UserRole.ADMIN),
  brandingImageMemory.single("splash"),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      if (!req.file) {
        return res.status(400).json({ message: "No image file provided" });
      }
      const url = await uploadBrandingImageBuffer(req.file.buffer, societyId, "splash");
      await prisma.society.updateMany({
        where: { id: societyId },
        data: { splashUrl: url },
      });
      await bustSocietySettingsCache(societyId);
      return res.json({ url });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * DELETE /api/society-settings/splash — remove the splash image (ADMIN).
 */
router.delete(
  "/splash",
  requireRole(UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      await prisma.society.updateMany({
        where: { id: societyId },
        data: { splashUrl: null },
      });
      await bustSocietySettingsCache(societyId);
      return res.json({ message: "Splash removed" });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
