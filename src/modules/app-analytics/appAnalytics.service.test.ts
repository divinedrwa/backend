import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AppAnalyticsEventKind,
  AppAnalyticsPlatform,
  UserRole,
} from "@prisma/client";
import {
  getAppAnalyticsSummary,
  recordAnalyticsEvent,
} from "./appAnalytics.service.js";

describe("appAnalytics.service", () => {
  it("records events and builds summary counts", async () => {
    const sessions: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const societyId = "soc1";
    const userId = "u1";

    const db = {
      appAnalyticsSession: {
        findMany: async (args?: { distinct?: string[] }) => {
          if (args?.distinct) return [{ userId }];
          return sessions;
        },
      },
      appAnalyticsEvent: {
        findMany: async (args?: { distinct?: string[] }) => {
          if (args?.distinct) return [{ userId }];
          return events;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `e${events.length + 1}`, ...data };
          events.push(row);
          return row;
        },
        groupBy: async () => [],
      },
      pushDevice: {
        findMany: async () => [
          {
            platform: "ANDROID",
            deviceType: "ANDROID",
            lastUsedAt: new Date(),
            userId,
          },
        ],
      },
      refreshToken: {
        findMany: async () => [],
      },
      user: {
        groupBy: async () => [{ role: UserRole.RESIDENT, _count: 10 }],
        findFirst: async () => ({
          name: "Resident",
          username: "r1",
          isActive: true,
          villa: { villaNumber: "A-101" },
        }),
        findMany: async () => [
          { id: userId, isActive: true, role: UserRole.RESIDENT },
        ],
      },
    };

    await recordAnalyticsEvent(db as never, {
      societyId,
      userId,
      role: UserRole.RESIDENT,
      defaultPlatform: AppAnalyticsPlatform.ANDROID,
      event: {
        kind: AppAnalyticsEventKind.LOGIN,
        name: "login_success",
        clientEventId: "login-1",
      },
    });

    sessions.push({
      id: "s1",
      userId,
      role: UserRole.RESIDENT,
      platform: AppAnalyticsPlatform.ANDROID,
      appVersion: "1.1.21",
      deviceId: "dev1",
      startedAt: new Date(),
      endedAt: null,
      lastSeenAt: new Date(),
      user: { name: "Resident", username: "r1" },
    });

    const summary = await getAppAnalyticsSummary(db as never, societyId, 30);
    assert.equal(summary.totals.logins, 1);
    assert.equal(summary.totals.sessions, 1);
    assert.equal(summary.pushDevices.registered, 1);
    assert.equal(events[0]?.userName, "Resident");
    assert.equal(summary.engagement.activeInPeriod, 1);
  });
});
