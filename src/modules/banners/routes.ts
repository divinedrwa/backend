import { Router } from "express";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import { BannerType, NotificationCategory, Prisma } from "@prisma/client";
import { broadcastNoticeToAllResidents } from "../../services/notification.service";
import { cacheMiddleware, invalidateSocietyCache } from "../../middlewares/cache";

const router = Router();

/** Banner is eligible for resident home carousel — same window as GET /active/list. */
function bannerIsInActiveWindow(banner: {
  isActive: boolean;
  startDate: Date;
  endDate: Date | null;
}): boolean {
  const now = new Date();
  if (!banner.isActive) return false;
  if (banner.startDate > now) return false;
  if (banner.endDate != null && banner.endDate < now) return false;
  return true;
}

function notifyResidentsAboutBanner(banner: {
  id: string;
  societyId: string;
  title: string;
  description: string | null;
  type: BannerType;
}): void {
  const desc = (banner.description ?? "").trim();
  const preview = desc.length > 220 ? `${desc.slice(0, 220)}…` : desc;
  const body =
    preview.length > 0 ? preview : "Open the app to view this announcement.";

  void broadcastNoticeToAllResidents({
    societyId: banner.societyId,
    title: banner.title,
    body,
    category: NotificationCategory.BROADCAST,
    data: {
      type: "banner",
      bannerId: banner.id,
      societyId: banner.societyId,
      bannerType: banner.type,
    },
  }).catch((err) =>
    logger.error({ err }, "[notifications] banner broadcast failed"),
  );
}

// Validation schemas
const createBannerSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().optional(),
  imageUrl: z.string().url().optional(),
  type: z.nativeEnum(BannerType).default(BannerType.ANNOUNCEMENT),
  priority: z.number().int().min(0).max(100).default(0),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  isActive: z.boolean().default(true),
  actionUrl: z.string().url().optional(),
});

const updateBannerSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().optional(),
  imageUrl: z.string().url().optional(),
  type: z.nativeEnum(BannerType).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  isActive: z.boolean().optional(),
  actionUrl: z.string().url().optional(),
});

router.use(requireAuth);

// ========================================
// Residents / guards — register BEFORE "/:id" or "/active/list" is handled as id "active"
// ========================================

// GET /api/banners/active/list
router.get("/active/list", cacheMiddleware(120), async (req, res, next) => {
  try {
    const now = new Date();

    const banners = await prisma.banner.findMany({
      where: {
        societyId: req.auth!.societyId,
        isActive: true,
        startDate: {
          lte: now,
        },
        OR: [{ endDate: null }, { endDate: { gte: now } }],
      },
      select: {
        id: true,
        title: true,
        description: true,
        imageUrl: true,
        type: true,
        priority: true,
        startDate: true,
        endDate: true,
        actionUrl: true,
        createdAt: true,
      },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    });

    return res.json({ banners });
  } catch (error) {
    next(error);
  }
});

// POST /api/banners/:id/register
router.post("/:id/register", async (req, res, next) => {
  try {
    const { id } = req.params;
    const now = new Date();
    const banner = await prisma.banner.findFirst({
      where: {
        id,
        societyId: req.auth!.societyId,
        isActive: true,
        startDate: { lte: now },
        OR: [{ endDate: null }, { endDate: { gte: now } }],
      },
      select: {
        id: true,
        title: true,
        type: true,
        actionUrl: true,
      },
    });

    if (!banner) {
      return res.status(404).json({ message: "Event not found or inactive" });
    }

    const registerableTypes: BannerType[] = [
      BannerType.EVENT,
      BannerType.FESTIVAL,
      BannerType.COMMUNITY,
    ];
    if (!registerableTypes.includes(banner.type)) {
      return res.status(400).json({ message: "This banner is not registerable" });
    }

    return res.json({
      message: "Registration interest recorded successfully",
      registration: {
        bannerId: banner.id,
        title: banner.title,
        actionUrl: banner.actionUrl,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ========================================
// ADMIN ROUTES
// ========================================

// GET /api/banners - List all banners (Admin only)
router.get(
  "/",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const banners = await prisma.banner.findMany({
        where: { societyId: req.auth!.societyId },
        include: {
          creator: {
            select: {
              name: true,
              email: true
            }
          }
        },
        orderBy: [
          { priority: "desc" },
          { createdAt: "desc" }
        ]
      });

      return res.json({ banners });
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/banners/:id - Get banner by ID (Admin only)
router.get(
  "/:id",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const banner = await prisma.banner.findFirst({
        where: {
          id: req.params.id,
          societyId: req.auth!.societyId
        },
        include: {
          creator: {
            select: {
              name: true,
              email: true
            }
          }
        }
      });

      if (!banner) {
        return res.status(404).json({ message: "Banner not found" });
      }

      return res.json({ banner });
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/banners - Create new banner (Admin only)
router.post(
  "/",
  requireRole("ADMIN"),
  validateBody(createBannerSchema),
  async (req, res, next) => {
    try {
      const data = req.body;

      const banner = await prisma.banner.create({
        data: {
          title: data.title,
          description: data.description,
          imageUrl: data.imageUrl,
          type: data.type || BannerType.ANNOUNCEMENT,
          priority: data.priority ?? 0,
          startDate: data.startDate ? new Date(data.startDate) : new Date(),
          endDate: data.endDate ? new Date(data.endDate) : null,
          isActive: data.isActive ?? true,
          actionUrl: data.actionUrl,
          societyId: req.auth!.societyId,
          createdBy: req.auth!.userId
        },
        include: {
          creator: {
            select: {
              name: true,
              email: true
            }
          }
        }
      });

      if (bannerIsInActiveWindow(banner)) {
        notifyResidentsAboutBanner(banner);
      }

      await invalidateSocietyCache(req.auth!.societyId, "/active/list");

      return res.status(201).json({
        message: "Banner created successfully",
        banner
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /api/banners/:id - Update banner (Admin only)
router.put(
  "/:id",
  requireRole("ADMIN"),
  validateBody(updateBannerSchema),
  async (req, res, next) => {
    try {
      const bannerId = req.params.id;
      const data = req.body;

      // Check if banner exists and belongs to this society
      const existing = await prisma.banner.findFirst({
        where: {
          id: bannerId,
          societyId: req.auth!.societyId
        }
      });

      if (!existing) {
        return res.status(404).json({ message: "Banner not found" });
      }

      const updateData: Prisma.BannerUpdateInput = {};
      if (data.title !== undefined) updateData.title = data.title;
      if (data.description !== undefined) updateData.description = data.description;
      if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl;
      if (data.type !== undefined) updateData.type = data.type;
      if (data.priority !== undefined) updateData.priority = data.priority;
      if (data.startDate !== undefined) updateData.startDate = new Date(data.startDate);
      if (data.endDate !== undefined) updateData.endDate = data.endDate ? new Date(data.endDate) : null;
      if (data.isActive !== undefined) updateData.isActive = data.isActive;
      if (data.actionUrl !== undefined) updateData.actionUrl = data.actionUrl;

      const wasVisible = bannerIsInActiveWindow(existing);

      const banner = await prisma.banner.update({
        where: { id: bannerId },
        data: updateData,
        include: {
          creator: {
            select: {
              name: true,
              email: true
            }
          }
        }
      });

      const nowVisible = bannerIsInActiveWindow(banner);
      if (nowVisible && !wasVisible) {
        notifyResidentsAboutBanner(banner);
      }

      await invalidateSocietyCache(req.auth!.societyId, "/active/list");

      return res.json({
        message: "Banner updated successfully",
        banner
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/banners/:id - Delete banner (Admin only)
router.delete(
  "/:id",
  requireRole("ADMIN"),
  async (req, res, next) => {
    try {
      const bannerId = req.params.id;

      // Check if banner exists and belongs to this society
      const existing = await prisma.banner.findFirst({
        where: {
          id: bannerId,
          societyId: req.auth!.societyId
        }
      });

      if (!existing) {
        return res.status(404).json({ message: "Banner not found" });
      }

      await prisma.banner.delete({
        where: { id: bannerId }
      });

      await invalidateSocietyCache(req.auth!.societyId, "/active/list");

      return res.json({ message: "Banner deleted successfully" });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
