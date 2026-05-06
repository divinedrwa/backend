import { prisma } from "../lib/prisma";
import admin from "firebase-admin";
import { NotificationCategory, UserRole } from "@prisma/client";

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
      console.log("✅ Firebase Admin initialized (FIREBASE_SERVICE_ACCOUNT_JSON)");
    } catch (error) {
      console.error("❌ Error initializing Firebase Admin from FIREBASE_SERVICE_ACCOUNT_JSON:", error);
      console.error(
        "[DivineFCM-API] FCM push disabled: invalid FIREBASE_SERVICE_ACCOUNT_JSON or wrong project. " +
          "Use a service account JSON for the **same** Firebase project as divine_app (society-e1a2e).",
      );
    }
  } else {
    try {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
      console.log("✅ Firebase Admin initialized");
    } catch (error) {
      console.error("❌ Error initializing Firebase Admin:", error);
      console.error(
        "[DivineFCM-API] FCM push disabled: fix Firebase Admin credentials. " +
          "Set FIREBASE_SERVICE_ACCOUNT_JSON in .env, or export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json " +
          "for the **same** Firebase project as android/app/google-services.json (society-e1a2e).",
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
      console.log("[DivineFCM-API] sendToUser_target", {
        targetUserId: userId,
        category: options?.category ?? "SYSTEM",
        titlePreview: payload.title?.slice(0, 72),
        dataKeys: payload.data ? Object.keys(payload.data) : [],
        hasImageUrl: Boolean(payload.imageUrl),
      });

      // Get all active devices for this user
      const devices = await prisma.pushDevice.findMany({
        where: {
          userId,
          isActive: true,
        },
      });

      if (devices.length === 0) {
        console.log(
          `[DivineFCM-API] sendToUser_skip_push userId=${userId} reason=no_active_push_devices (login app & open once to register FCM)`,
        );
      } else {
        console.log(
          `[DivineFCM-API] sendToUser_devices userId=${userId} activeDeviceCount=${devices.length}`,
        );
        const tokens = devices.map((d) => d.token);
        try {
          await this.sendToTokens(tokens, payload);
        } catch (fcmErr) {
          // eslint-disable-next-line no-console
          console.error(`❌ FCM failed for user ${userId} (in-app notification will still be stored):`, fcmErr);
        }
      }

      if (options?.persistInApp === false) {
        return;
      }

      const societyId =
        (await prisma.user.findUnique({
          where: { id: userId },
          select: { societyId: true },
        }))?.societyId || "";

      await prisma.userNotification.create({
        data: {
          userId,
          societyId,
          category: options?.category ?? NotificationCategory.SYSTEM,
          title: payload.title,
          body: payload.body,
          data: payload.data || {},
          pushSent: devices.length > 0,
        },
      });
    } catch (error) {
      console.error(`❌ Error sending notification to user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Send notification to multiple users
   */
  static async sendToUsers(
    userIds: string[],
    payload: NotificationPayload,
    options?: SendToUserOptions,
  ): Promise<void> {
    console.log(`📤 Sending notification to ${userIds.length} users`);

    for (const userId of userIds) {
      try {
        await this.sendToUser(userId, payload, options);
      } catch (error) {
        console.error(`❌ Error sending to user ${userId}:`, error);
        // Continue with other users
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
      console.log("[DivineFCM-API] sendToSociety_target", {
        societyId,
        roleFilter: role ?? "ALL_ACTIVE_USERS",
        titlePreview: payload.title?.slice(0, 72),
      });

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
      console.log(
        `[DivineFCM-API] sendToSociety_recipients societyId=${societyId} userCount=${userIds.length}`,
      );

      await this.sendToUsers(userIds, payload, options);
    } catch (error) {
      console.error(`❌ Error sending to society ${societyId}:`, error);
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
      console.log("⚠️ No tokens provided");
      return;
    }

    /** Firebase `sendEachForMulticast` allows at most 500 registration tokens per call. */
    const FCM_MULTICAST_MAX = 500;

    console.log(`📤 Sending to ${tokens.length} device token(s) (chunked ≤${FCM_MULTICAST_MAX})`);

    for (let offset = 0; offset < tokens.length; offset += FCM_MULTICAST_MAX) {
      const chunk = tokens.slice(offset, offset + FCM_MULTICAST_MAX);
      try {
        const tokenPreview =
          chunk[0]?.length > 18 ? `${chunk[0].substring(0, 18)}…` : chunk[0];

        console.log("[DivineFCM-API] sendMulticast", {
          chunkOffset: offset,
          tokenCount: chunk.length,
          firstTokenPreview: tokenPreview ?? "(none)",
          titlePreview: payload.title?.slice(0, 80),
          bodyLen: payload.body?.length ?? 0,
          dataKeys: payload.data ? Object.keys(payload.data) : [],
        });

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

        console.log(`✅ Successfully sent: ${response.successCount}`);
        console.log(`❌ Failed to send: ${response.failureCount}`);
        console.log("[DivineFCM-API] multicast result", {
          successCount: response.successCount,
          failureCount: response.failureCount,
        });

        if (response.failureCount > 0) {
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              const tk = chunk[idx];
              console.error("[DivineFCM-API] token failure detail", {
                index: offset + idx,
                code: resp.error?.code,
                message: resp.error?.message,
                tokenPreview: tk && tk.length > 14 ? `${tk.substring(0, 14)}…` : tk,
              });
              console.error(`❌ Failed for token ${offset + idx}:`, resp.error);

              if (
                resp.error?.code === "messaging/invalid-registration-token" ||
                resp.error?.code === "messaging/registration-token-not-registered"
              ) {
                this.markDeviceInactive(chunk[idx]).catch(console.error);
              }
            }
          });
        }
      } catch (error) {
        console.error(`❌ Error sending notification chunk (offset ${offset}):`, error);
        throw error;
      }
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
      console.log(`📤 Sending notification to topic: ${topic}`);

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
      console.log(`✅ Successfully sent to topic ${topic}:`, response);
    } catch (error) {
      console.error(`❌ Error sending to topic ${topic}:`, error);
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
      console.log(`⚠️ Marked device as inactive: ${token.substring(0, 20)}...`);
    } catch (error) {
      console.error("❌ Error marking device inactive:", error);
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
      console.log(`✅ Removed device ${deviceId} for user ${userId}`);
    } catch (error) {
      console.error("❌ Error removing device:", error);
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

      console.log(`🧹 Cleaned up ${result.count} inactive devices`);
    } catch (error) {
      console.error("❌ Error cleaning up devices:", error);
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
  console.log("[DivineFCM-API] notifySocietyRoles_target", {
    societyId: params.societyId,
    roles: params.roles,
    category: params.category ?? "unspecified",
    titlePreview: params.title?.slice(0, 72),
  });
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
    console.log("[notice-delivery] no recipient user IDs");
    return { residentCount: 0, deviceTokensSent: 0 };
  }

  const payload: NotificationPayload = {
    title: params.title,
    body: params.body,
    data: params.data,
  };

  const jsonData = params.data ?? {};

  const devices = await prisma.pushDevice.findMany({
    where: {
      userId: { in: userIds },
      isActive: true,
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
      console.error("[notice-delivery] FCM failed after inbox rows were created:", e);
    }
  }

  console.log("[notice-delivery] completed", {
    societyId: params.societyId,
    residentAccounts: userIds.length,
    fcmTokenCount: tokens.length,
  });

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
      role: UserRole.RESIDENT,
      isActive: true,
    },
    select: { id: true },
  });

  const userIds = [...new Set(residents.map((r) => r.id))];

  if (userIds.length === 0) {
    console.log("[notice-broadcast] no active residents", { societyId: params.societyId });
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
