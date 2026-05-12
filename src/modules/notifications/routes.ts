import { Router } from "express";
import { z } from "zod";
import { NotificationCategory, PushPlatform, UserRole } from "@prisma/client";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { validateBody } from "../../middlewares/validate";
import {
  isFirebaseConfigured,
  notifySocietyRoles,
  notifyUserIds,
  registerPushDevice,
  removePushDevice,
} from "../../services/notification.service";

const router = Router();

const registerDeviceSchema = z.object({
  token: z.string().min(10),
  platform: z.nativeEnum(PushPlatform),
  /** Stable hardware id (Android ID / iOS identifierForVendor). Must match login upsert. */
  deviceId: z.string().min(1).optional(),
  deviceName: z.string().max(200).optional(),
});

const removeDeviceSchema = z.object({
  deviceId: z.string().min(1).optional(),
  /** @deprecated Legacy clients; prefer deviceId (hardware id). */
  token: z.string().min(10).optional(),
});

const broadcastSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
  category: z.nativeEnum(NotificationCategory).optional(),
  /** Roles that should receive this message within your society */
  targetRoles: z.array(z.nativeEnum(UserRole)).min(1),
});

router.use(requireAuth);

/** POST /api/notifications/devices — Register / refresh FCM device token (mobile apps). */
router.post("/devices", validateBody(registerDeviceSchema), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    const body = req.body as z.infer<typeof registerDeviceSchema>;
    const deviceId = (body.deviceId ?? "").trim() || body.token;
    const deviceType =
      body.platform === PushPlatform.IOS
        ? "IOS"
        : body.platform === PushPlatform.WEB
          ? "WEB"
          : "ANDROID";
    await registerPushDevice({
      userId,
      token: body.token,
      platform: body.platform,
      deviceId,
      deviceType,
      deviceName: body.deviceName,
    });
    // Don't log device ids or token previews — they're persistent identifiers
    // that should not appear in operational logs. Only retain enough to
    // confirm the registration path is being exercised.
    logger.info({
      userId,
      platform: body.platform,
      firebaseAdminReady: isFirebaseConfigured(),
    }, "Mobile FCM device registered");
    return res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/** POST /api/notifications/devices/remove — Unregister token (logout / uninstall). */
router.post("/devices/remove", validateBody(removeDeviceSchema), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    const body = req.body as z.infer<typeof removeDeviceSchema>;
    if (!body.deviceId?.trim() && !body.token?.trim()) {
      return res.status(400).json({ message: "deviceId or token required" });
    }
    const deviceId = body.deviceId?.trim();
    if (deviceId) {
      await removePushDevice(userId, deviceId);
    } else if (body.token) {
      await prisma.pushDevice.updateMany({
        where: { userId, token: body.token },
        data: { isActive: false },
      });
    }
    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/** GET /api/notifications — List notifications for the signed-in user (newest first). */
router.get("/", async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const take = Math.min(Number(req.query.limit ?? 30), 100);
    const skip = Number(req.query.skip ?? 0);

    const [items, unreadCount] = await Promise.all([
      prisma.userNotification.findMany({
        where: { userId, societyId },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.userNotification.count({
        where: { userId, societyId, readAt: null },
      }),
    ]);

    return res.json({ notifications: items, unreadCount });
  } catch (error) {
    next(error);
  }
});

/** PATCH /api/notifications/:id/read — Mark one notification as read. */
router.patch("/:id/read", async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    const { id } = req.params;

    const updated = await prisma.userNotification.updateMany({
      where: { id, userId, societyId },
      data: { readAt: new Date() },
    });

    if (updated.count === 0) {
      return res.status(404).json({ message: "Notification not found" });
    }

    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/** POST /api/notifications/read-all — Mark all as read for current user. */
router.post("/read-all", async (req, res, next) => {
  try {
    const { userId, societyId } = req.auth!;
    await prisma.userNotification.updateMany({
      where: { userId, societyId, readAt: null },
      data: { readAt: new Date() },
    });
    return res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/** POST /api/notifications/broadcast — Society-wide messages (admin only). */
router.post(
  "/broadcast",
  requireRole(UserRole.ADMIN),
  validateBody(broadcastSchema),
  async (req, res, next) => {
    try {
      const { societyId } = req.auth!;
      const body = req.body as z.infer<typeof broadcastSchema>;

      await notifySocietyRoles({
        societyId,
        roles: body.targetRoles,
        category: body.category ?? NotificationCategory.BROADCAST,
        title: body.title,
        body: body.body,
      });

      return res.status(201).json({
        ok: true,
        firebaseConfigured: isFirebaseConfigured(),
      });
    } catch (error) {
      next(error);
    }
  }
);

/** GET /api/notifications/diagnostics — Push registration stats (admin only). */
router.get("/diagnostics", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { societyId } = req.auth!;

    const [deviceCount, userIdsWithDevice, last24h] = await Promise.all([
      prisma.pushDevice.count({
        where: { user: { societyId, isActive: true } },
      }),
      prisma.pushDevice.findMany({
        where: { user: { societyId } },
        select: { userId: true },
        distinct: ["userId"],
      }),
      prisma.userNotification.count({
        where: {
          societyId,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    return res.json({
      firebaseConfigured: isFirebaseConfigured(),
      registeredDevices: deviceCount,
      usersWithAtLeastOneDevice: userIdsWithDevice.length,
      notificationsCreatedLast24h: last24h,
    });
  } catch (error) {
    next(error);
  }
});

/** POST /api/notifications/send-test — Send to yourself only (admin QA). */
router.post("/send-test", requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const { userId } = req.auth!;
    await notifyUserIds([userId], {
      title: "Test notification",
      body: "If you see this on your phone, push delivery is working.",
      data: { source: "send-test" },
    });
    return res.json({ ok: true, firebaseConfigured: isFirebaseConfigured() });
  } catch (error) {
    next(error);
  }
});

export default router;
