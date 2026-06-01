import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import admin from "firebase-admin";
import { NotificationCategory, UserRole } from "@prisma/client";
import { RESIDENT_LIKE_ROLES } from "../lib/residentLike";

// Initialize Firebase Admin SDK (if not already initialized).
// Prefer FIREBASE_SERVICE_ACCOUNT_JSON from .env (dotenv must load before this module — see app.ts).
// Otherwise Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS path or gcloud).
if (!admin.apps.length) {
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonEnv) {
    try {
      const parsed = JSON.parse(jsonEnv) as Record<string, unknown>;
      admin.initializeApp({
        credential: admin.credential.cert(parsed as admin.ServiceAccount),
      });
      logger.info("Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_JSON");
    } catch (error) {
      logger.error(
        { err: error },
        "Error initializing Firebase Admin from FIREBASE_SERVICE_ACCOUNT_JSON",
      );
      logger.error(
        "FCM push disabled: invalid FIREBASE_SERVICE_ACCOUNT_JSON or wrong project. Use a service account JSON for the same Firebase project as divine_app (society-e1a2e).",
      );
    }
  } else {
    try {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
      logger.info("Firebase Admin initialized from application default credentials");
    } catch (error) {
      logger.error({ err: error }, "Error initializing Firebase Admin");
      logger.error(
        "FCM push disabled: fix Firebase Admin credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON in .env, or export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json for the same Firebase project as android/app/google-services.json (society-e1a2e).",
      );
    }
  }
}

export interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
}

export interface SendNotificationOptions {
  userId?: string;
  userIds?: string[];
  role?: UserRole;
  societyId?: string;
  topic?: string;
}

export interface SendToUserOptions {
  category?: NotificationCategory;
  /** When false, only push is attempted; no UserNotification row (default: true). */
  persistInApp?: boolean;
}

/**
 * Notification Service
 * Handles sending push notifications to multiple devices
 */
export class NotificationService {
  /**
   * Send notification to a single user (all their devices)
   */
  static async sendToUser(
    userId: string,
    payload: NotificationPayload,
    options?: SendToUserOptions,
  ): Promise<void> {
    try {
      logger.debug({
        targetUserId: userId,
        category: options?.category ?? "SYSTEM",
        titlePreview: payload.title?.slice(0, 72),
        dataKeys: payload.data ? Object.keys(payload.data) : [],
        hasImageUrl: Boolean(payload.imageUrl),
      }, "sendToUser target");

      // Fetch user preferences up-front (also gives us societyId for the inbox row).
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { societyId: true, notifyPush: true },
      });

      if (!user) {
        logger.warn({ userId }, "sendToUser: user not found, skipping");
        return;
      }

      const societyId = user.societyId || "";
      let pushSent = false;

      // Only attempt FCM when the user has push enabled globally.
      if (user.notifyPush) {
        const devices = await prisma.pushDevice.findMany({
          where: {
            userId,
            isActive: true,
          },
        });

        if (devices.length === 0) {
          logger.debug(
            { userId },
            "Skipping push for user because there are no active push devices",
          );
        } else {
          logger.debug(
            { userId, activeDeviceCount: devices.length },
            "Found active push devices for user",
          );
          const tokens = devices.map((d) => d.token);
          try {
            await this.sendToTokens(tokens, payload);
            pushSent = true;
          } catch (fcmErr) {
            logger.warn(
              { err: fcmErr, userId },
              "FCM failed for user; in-app notification will still be stored",
            );
          }
        }
      } else {
        logger.debug({ userId }, "Skipping push because user has notifyPush disabled");
      }

      if (options?.persistInApp === false) {
        return;
      }

      await prisma.userNotification.create({
        data: {
          userId,
          societyId,
          category: options?.category ?? NotificationCategory.SYSTEM,
          title: payload.title,
          body: payload.body,
          data: payload.data || {},
          pushSent,
        },
      });
    } catch (error) {
      logger.error({ err: error, userId }, "Error sending notification to user");
      throw error;
    }
  }

  /**
   * Send notification to multiple users with bulk-fetched preferences and devices.
   * Avoids N+1 per-user DB queries for large recipient lists.
   */
  static async sendToUsers(
    userIds: string[],
    payload: NotificationPayload,
    options?: SendToUserOptions,
  ): Promise<void> {
    if (userIds.length === 0) return;
    logger.info({ userCount: userIds.length }, "Sending notification to users (bulk)");

    // For small batches, fall back to per-user path (less overhead)
    if (userIds.length <= 5) {
      const CONCURRENCY = 5;
      for (let i = 0; i < userIds.length; i += CONCURRENCY) {
        const batch = userIds.slice(i, i + CONCURRENCY);
        await Promise.allSettled(
          batch.map((userId) =>
            this.sendToUser(userId, payload, options).catch((error) => {
              logger.error({ err: error, userId }, "Error sending notification to user in batch");
            }),
          ),
        );
      }
      return;
    }

    // Bulk path: fetch all user prefs + devices in two queries
    const CHUNK = 200;
    for (let i = 0; i < userIds.length; i += CHUNK) {
      const chunk = userIds.slice(i, i + CHUNK);
      try {
        const [users, devices] = await Promise.all([
          prisma.user.findMany({
            where: { id: { in: chunk } },
            select: { id: true, societyId: true, notifyPush: true },
          }),
          prisma.pushDevice.findMany({
            where: { userId: { in: chunk }, isActive: true },
            select: { userId: true, token: true },
          }),
        ]);

        // Group devices by userId
        const devicesByUser = new Map<string, string[]>();
        for (const d of devices) {
          const arr = devicesByUser.get(d.userId) ?? [];
          arr.push(d.token);
          devicesByUser.set(d.userId, arr);
        }

        // Collect all tokens for push-enabled users
        const allTokens: string[] = [];
        const pushSentUserIds = new Set<string>();
        for (const user of users) {
          if (user.notifyPush) {
            const tokens = devicesByUser.get(user.id);
            if (tokens && tokens.length > 0) {
              allTokens.push(...tokens);
              pushSentUserIds.add(user.id);
            }
          }
        }

        // Send push in one batch
        if (allTokens.length > 0) {
          try {
            await this.sendToTokens(allTokens, payload);
          } catch (fcmErr) {
            logger.warn({ err: fcmErr, tokenCount: allTokens.length }, "Bulk FCM send failed");
          }
        }

        // Persist in-app notifications
        if (options?.persistInApp !== false) {
          const inAppRows = users
            .filter((u) => u.societyId)
            .map((u) => ({
              userId: u.id,
              societyId: u.societyId!,
              category: options?.category ?? NotificationCategory.SYSTEM,
              title: payload.title,
              body: payload.body,
              data: payload.data || {},
              pushSent: pushSentUserIds.has(u.id),
            }));

          if (inAppRows.length > 0) {
            await prisma.userNotification.createMany({ data: inAppRows });
          }
        }
      } catch (error) {
        logger.error({ err: error, chunkStart: i, chunkSize: chunk.length }, "Bulk notification chunk failed");
      }
    }
  }

  /**
   * Send notification to all users in a society
   */
  static async sendToSociety(
    societyId: string,
    payload: NotificationPayload,
    role?: UserRole,
    options?: SendToUserOptions,
  ): Promise<void> {
    try {
      logger.debug({
        societyId,
        roleFilter: role ?? "ALL_ACTIVE_USERS",
        titlePreview: payload.title?.slice(0, 72),
      }, "sendToSociety target");

      // Get all users in society (optionally filtered by role).
      // Use explicit undefined check — `role && { role }` would wrongly skip filtering if ADMIN were ever numeric 0.
      const users = await prisma.user.findMany({
        where: {
          societyId,
          isActive: true,
          ...(role !== undefined ? { role } : {}),
        },
        select: {
          id: true,
        },
      });

      const userIds = users.map((u) => u.id);
      logger.info(
        { societyId, userCount: userIds.length, roleFilter: role ?? "ALL_ACTIVE_USERS" },
        "Resolved society notification recipients",
      );

      await this.sendToUsers(userIds, payload, options);
    } catch (error) {
      logger.error({ err: error, societyId }, "Error sending notification to society");
      throw error;
    }
  }

  /**
   * Send notification to specific device tokens
   */
  static async sendToTokens(
    tokens: string[],
    payload: NotificationPayload
  ): Promise<void> {
    if (tokens.length === 0) {
      logger.warn("No push tokens provided");
      return;
    }

    /** Firebase `sendEachForMulticast` allows at most 500 registration tokens per call. */
    const FCM_MULTICAST_MAX = 500;

    logger.info(
      { tokenCount: tokens.length, maxChunkSize: FCM_MULTICAST_MAX },
      "Sending notification to device tokens",
    );

    const chunkErrors: Array<{ offset: number; error: unknown }> = [];

    for (let offset = 0; offset < tokens.length; offset += FCM_MULTICAST_MAX) {
      const chunk = tokens.slice(offset, offset + FCM_MULTICAST_MAX);
      try {
        const tokenPreview =
          chunk[0]?.length > 18 ? `${chunk[0].substring(0, 18)}…` : chunk[0];

        logger.debug({
          chunkOffset: offset,
          tokenCount: chunk.length,
          firstTokenPreview: tokenPreview ?? "(none)",
          titlePreview: payload.title?.slice(0, 80),
          bodyLen: payload.body?.length ?? 0,
          dataKeys: payload.data ? Object.keys(payload.data) : [],
        }, "Sending notification multicast chunk");

        const dataPayload: Record<string, string> = {};
        for (const [k, v] of Object.entries(payload.data || {})) {
          dataPayload[k] = v == null ? "" : String(v);
        }
        dataPayload.title = payload.title;
        dataPayload.body = payload.body;

        const message: admin.messaging.MulticastMessage = {
          tokens: chunk,
          notification: {
            title: payload.title,
            body: payload.body,
            ...(payload.imageUrl && { imageUrl: payload.imageUrl }),
          },
          data: dataPayload,
          android: {
            priority: "high",
            notification: {
              sound: "default",
              channelId: "default",
              visibility: "public",
              ticker: payload.title,
              ...(payload.imageUrl && { imageUrl: payload.imageUrl }),
            },
          },
          apns: {
            headers: {
              "apns-priority": "10",
              "apns-push-type": "alert",
            },
            payload: {
              aps: {
                sound: "default",
                badge: 1,
              },
            },
          },
        };

        const response = await admin.messaging().sendEachForMulticast(message);

        logger.info({
          successCount: response.successCount,
          failureCount: response.failureCount,
          chunkOffset: offset,
        }, "Notification multicast result");

        if (response.failureCount > 0) {
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              const tk = chunk[idx];
              logger.error({
                index: offset + idx,
                code: resp.error?.code,
                message: resp.error?.message,
                tokenPreview: tk && tk.length > 14 ? `${tk.substring(0, 14)}…` : tk,
              }, "Notification token failure detail");

              if (
                resp.error?.code === "messaging/invalid-registration-token" ||
                resp.error?.code === "messaging/registration-token-not-registered"
              ) {
                this.markDeviceInactive(chunk[idx]).catch((err) => {
                  logger.error({ err, tokenPreview: tk && tk.length > 14 ? `${tk.substring(0, 14)}…` : tk }, "Failed to mark device inactive");
                });
              }
            }
          });
        }
      } catch (error) {
        logger.error({ err: error, chunkOffset: offset }, "Error sending notification chunk");
        chunkErrors.push({ offset, error });
        // Continue with remaining chunks — don't break the loop
      }
    }

    if (chunkErrors.length > 0) {
      logger.warn({ failedChunks: chunkErrors.length, totalChunks: Math.ceil(tokens.length / FCM_MULTICAST_MAX) }, "Some notification chunks failed to send");
    }
  }

  /**
   * Send notification to a topic
   */
  static async sendToTopic(
    topic: string,
    payload: NotificationPayload
  ): Promise<void> {
    try {
      logger.info({ topic }, "Sending notification to topic");

      const message: admin.messaging.Message = {
        topic,
        notification: {
          title: payload.title,
          body: payload.body,
          ...(payload.imageUrl && { imageUrl: payload.imageUrl }),
        },
        data: payload.data || {},
        android: {
          priority: "high",
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
            },
          },
        },
      };

      const response = await admin.messaging().send(message);
      logger.info({ topic, response }, "Successfully sent notification to topic");
    } catch (error) {
      logger.error({ err: error, topic }, "Error sending notification to topic");
      throw error;
    }
  }

  /**
   * Mark device as inactive
   */
  private static async markDeviceInactive(token: string): Promise<void> {
    try {
      await prisma.pushDevice.updateMany({
        where: { token },
        data: { isActive: false },
      });
      logger.warn({ tokenPreview: `${token.substring(0, 20)}...` }, "Marked device as inactive");
    } catch (error) {
      logger.error({ err: error }, "Error marking device inactive");
    }
  }

  /**
   * Get all active devices for a user
   */
  static async getUserDevices(userId: string) {
    return prisma.pushDevice.findMany({
      where: {
        userId,
        isActive: true,
      },
    });
  }

  /**
   * Remove device token (for logout)
   */
  static async removeDevice(userId: string, deviceId: string): Promise<void> {
    try {
      await prisma.pushDevice.updateMany({
        where: {
          userId,
          deviceId,
        },
        data: {
          isActive: false,
        },
      });
      logger.info({ userId, deviceId }, "Removed push device for user");
    } catch (error) {
      logger.error({ err: error, userId, deviceId }, "Error removing push device");
      throw error;
    }
  }

  /**
   * Clean up inactive devices (older than 90 days)
   */
  static async cleanupInactiveDevices(): Promise<void> {
    try {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const result = await prisma.pushDevice.deleteMany({
        where: {
          isActive: false,
          lastUsedAt: {
            lt: ninetyDaysAgo,
          },
        },
      });

      logger.info({ removedCount: result.count }, "Cleaned up inactive devices");
    } catch (error) {
      logger.error({ err: error }, "Error cleaning up inactive devices");
    }
  }
}

// Helper function to send notification to a single user
export async function notifyUser(
  userId: string,
  payload: NotificationPayload,
  options?: SendToUserOptions,
) {
  return NotificationService.sendToUser(userId, payload, options);
}

// Helper function to send notification to multiple users
export async function notifyUsers(
  userIds: string[],
  payload: NotificationPayload,
  options?: SendToUserOptions,
) {
  return NotificationService.sendToUsers(userIds, payload, options);
}

// Helper function to send notification to society
export async function notifySociety(
  societyId: string,
  payload: NotificationPayload,
  role?: UserRole,
  options?: SendToUserOptions,
) {
  return NotificationService.sendToSociety(societyId, payload, role, options);
}

// Backward-compatible helpers used by multiple modules.
export function isFirebaseConfigured(): boolean {
  return admin.apps.length > 0;
}

export async function notifySocietyRoles(params: {
  societyId: string;
  roles: UserRole[];
  category?: NotificationCategory;
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
}) {
  logger.info({
    societyId: params.societyId,
    roles: params.roles,
    category: params.category ?? "unspecified",
    titlePreview: params.title?.slice(0, 72),
  }, "notifySocietyRoles target");
  const payload: NotificationPayload = {
    title: params.title,
    body: params.body,
    data: params.data,
    imageUrl: params.imageUrl,
  };
  const sendOpts: SendToUserOptions | undefined = params.category
    ? { category: params.category }
    : undefined;
  await Promise.all(
    params.roles.map((role) => notifySociety(params.societyId, payload, role, sendOpts)),
  );
}

export async function notifyUserIds(userIds: string[], payload: NotificationPayload) {
  return notifyUsers(userIds, payload);
}

/**
 * Persist notice inbox rows + FCM for the given resident user IDs (society-scoped; callers validate membership).
 */
export async function deliverNoticeNotificationsToResidents(params: {
  societyId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  userIds: string[];
  /** Defaults to NOTICE (notice board). Use BROADCAST for society-wide banners / campaigns. */
  category?: NotificationCategory;
}): Promise<{ residentCount: number; deviceTokensSent: number }> {
  const userIds = [...new Set(params.userIds)];

  if (userIds.length === 0) {
    logger.info("Notice delivery skipped because there were no recipient user IDs");
    return { residentCount: 0, deviceTokensSent: 0 };
  }

  const payload: NotificationPayload = {
    title: params.title,
    body: params.body,
    data: params.data,
  };

  const jsonData = params.data ?? {};

  // Only fetch devices for users who have push notifications enabled.
  const devices = await prisma.pushDevice.findMany({
    where: {
      userId: { in: userIds },
      isActive: true,
      user: { notifyPush: true },
    },
    select: { userId: true, token: true },
  });

  const usersWithDevice = new Set(devices.map((d) => d.userId));
  const tokens = devices.map((d) => d.token).filter((t) => Boolean(t?.length));

  const category = params.category ?? NotificationCategory.NOTICE;

  await prisma.userNotification.createMany({
    data: userIds.map((userId) => ({
      userId,
      societyId: params.societyId,
      category,
      title: params.title,
      body: params.body,
      data: jsonData,
      pushSent: usersWithDevice.has(userId),
    })),
  });

  if (tokens.length > 0) {
    try {
      await NotificationService.sendToTokens(tokens, payload);
    } catch (e) {
      logger.error({ err: e, societyId: params.societyId }, "Notice delivery FCM failed after inbox rows were created");
    }
  }

  logger.info({
    societyId: params.societyId,
    residentAccounts: userIds.length,
    fcmTokenCount: tokens.length,
  }, "Notice delivery completed");

  return { residentCount: userIds.length, deviceTokensSent: tokens.length };
}

/**
 * Notice board: all active residents in the society.
 */
export async function broadcastNoticeToAllResidents(params: {
  societyId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  category?: NotificationCategory;
}): Promise<{ residentCount: number; deviceTokensSent: number }> {
  const residents = await prisma.user.findMany({
    where: {
      societyId: params.societyId,
      role: { in: RESIDENT_LIKE_ROLES },
      isActive: true,
    },
    select: { id: true },
  });

  const userIds = [...new Set(residents.map((r) => r.id))];

  if (userIds.length === 0) {
    logger.info({ societyId: params.societyId }, "Notice broadcast skipped because there are no active residents");
    return { residentCount: 0, deviceTokensSent: 0 };
  }

  return deliverNoticeNotificationsToResidents({
    societyId: params.societyId,
    title: params.title,
    body: params.body,
    data: params.data,
    userIds,
    category: params.category,
  });
}

/** Targeted notice: only the listed resident accounts (IDs must already be validated). */
export async function broadcastNoticeToSelectedResidents(params: {
  societyId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  userIds: string[];
  category?: NotificationCategory;
}): Promise<{ residentCount: number; deviceTokensSent: number }> {
  return deliverNoticeNotificationsToResidents({
    societyId: params.societyId,
    title: params.title,
    body: params.body,
    data: params.data,
    userIds: params.userIds,
    category: params.category,
  });
}

export async function registerPushDevice(input: {
  userId: string;
  token: string;
  deviceId: string;
  deviceType: string;
  deviceName?: string;
  platform?: "ANDROID" | "IOS" | "WEB";
}) {
  const existing = await prisma.pushDevice.findFirst({
    where: { userId: input.userId, deviceId: input.deviceId },
    select: { id: true },
  });
  if (existing) {
    return prisma.pushDevice.update({
      where: { id: existing.id },
      data: {
        token: input.token,
        deviceType: input.deviceType,
        deviceName: input.deviceName,
        platform: input.platform ?? "ANDROID",
        isActive: true,
        lastUsedAt: new Date(),
      },
    });
  }
  return prisma.pushDevice.create({
    data: {
      userId: input.userId,
      token: input.token,
      deviceId: input.deviceId,
      deviceType: input.deviceType,
      deviceName: input.deviceName,
      platform: input.platform ?? "ANDROID",
      isActive: true,
      lastUsedAt: new Date(),
    },
  });
}

export async function removePushDevice(userId: string, deviceId: string) {
  return NotificationService.removeDevice(userId, deviceId);
}
