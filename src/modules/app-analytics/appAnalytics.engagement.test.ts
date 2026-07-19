import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AppAnalyticsEventKind,
  AppAnalyticsPlatform,
  UserRole,
} from "@prisma/client";
import {
  getAppAnalyticsUserEngagement,
  recordAnalyticsEvent,
} from "./appAnalytics.service.js";
import { mergeUserIntoProperties } from "./userSnapshot.js";

describe("appAnalytics user snapshot", () => {
  it("server user fields win over client properties spread", () => {
    const merged = mergeUserIntoProperties(
      {
        userName: "Real Name",
        username: "real_user",
        villaNumber: "A-1",
        userIsActive: true,
      },
      "uid-1",
      UserRole.GUARD,
      { userId: "spoof", role: "ADMIN", userName: "Fake" },
    ) as Record<string, unknown>;

    assert.equal(merged.userId, "uid-1");
    assert.equal(merged.role, UserRole.GUARD);
    assert.equal(merged.userName, "Real Name");
  });
});

describe("appAnalytics engagement", () => {
  it("classifies active, inactive, never-used, and deactivated users", async () => {
    const societyId = "soc1";
    const now = new Date();

    const users = [
      {
        id: "active1",
        name: "Active User",
        username: "active",
        role: UserRole.RESIDENT,
        isActive: true,
        villa: { villaNumber: "101" },
      },
      {
        id: "inactive1",
        name: "Dormant User",
        username: "dormant",
        role: UserRole.GUARD,
        isActive: true,
        villa: null,
      },
      {
        id: "never1",
        name: "Never User",
        username: "never",
        role: UserRole.ADMIN,
        isActive: true,
        villa: null,
      },
      {
        id: "deact1",
        name: "Deactivated",
        username: "deact",
        role: UserRole.RESIDENT,
        isActive: false,
        villa: null,
      },
    ];

    const db = {
      user: {
        findMany: async () => users,
      },
      appAnalyticsSession: {
        findMany: async (args: {
          where?: { lastSeenAt?: { gte: Date }; societyId?: string };
          distinct?: string[];
        }) => {
          if (args.distinct) {
            return [{ userId: "active1" }, { userId: "inactive1" }];
          }
          if (args.where?.lastSeenAt) {
            return [{ userId: "active1", lastSeenAt: now }];
          }
          return [];
        },
      },
      appAnalyticsEvent: {
        findMany: async (args?: { distinct?: string[] }) => {
          if (args?.distinct) return [];
          return [];
        },
      },
    };

    const engagement = await getAppAnalyticsUserEngagement(
      db as never,
      societyId,
      30,
      50,
    );

    assert.equal(engagement.counts.activeInPeriod, 1);
    assert.equal(engagement.counts.inactiveInPeriod, 1);
    assert.equal(engagement.counts.neverUsedApp, 1);
    assert.equal(engagement.counts.deactivatedAccounts, 1);
    assert.equal(engagement.totals.active, 1);
    assert.equal(engagement.inactiveUsers[0]?.userId, "inactive1");
    assert.equal(engagement.neverUsedUsers[0]?.userId, "never1");
  });

  it("stores user snapshot columns on ingest", async () => {
    const events: Array<Record<string, unknown>> = [];
    const db = {
      user: {
        findFirst: async () => ({
          name: "Guard One",
          username: "guard1",
          isActive: true,
          villa: null,
        }),
      },
      appAnalyticsEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          events.push(data);
          return { id: "e1", occurredAt: new Date() };
        },
      },
    };

    await recordAnalyticsEvent(db as never, {
      societyId: "soc1",
      userId: "g1",
      role: UserRole.GUARD,
      defaultPlatform: AppAnalyticsPlatform.ANDROID,
      event: {
        kind: AppAnalyticsEventKind.LOGIN,
        name: "login_success",
        clientEventId: "login-guard-1",
      },
    });

    assert.equal(events[0]?.userName, "Guard One");
    assert.equal(events[0]?.username, "guard1");
    assert.equal(events[0]?.userIsActive, true);
    const props = events[0]?.properties as Record<string, unknown>;
    assert.equal(props.userId, "g1");
    assert.equal(props.role, UserRole.GUARD);
  });
});
