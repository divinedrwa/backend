import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AppAnalyticsEventKind,
  AppAnalyticsPlatform,
  UserRole,
} from "@prisma/client";
import {
  getAppAnalyticsRoleAdoption,
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
        findMany: async (args?: { distinct?: string[]; where?: { occurredAt?: { gte: Date } } }) => {
          if (args?.distinct) return [];
          return [];
        },
      },
      pushDevice: {
        findMany: async () => [
          { userId: "inactive1", lastUsedAt: new Date(now.getTime() - 60 * 86_400_000) },
        ],
      },
      refreshToken: {
        findMany: async () => [],
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

  it("treats push-only users as active, not never-used", async () => {
    const societyId = "soc1";
    const now = new Date();
    const users = [
      {
        id: "push1",
        name: "Push User",
        username: "push_user",
        role: UserRole.RESIDENT,
        isActive: true,
        villa: { villaNumber: "29" },
      },
    ];

    const db = {
      user: { findMany: async () => users },
      appAnalyticsSession: {
        findMany: async (args: { distinct?: string[]; where?: { lastSeenAt?: { gte: Date } } }) => {
          if (args.distinct) return [];
          if (args.where?.lastSeenAt) return [];
          return [];
        },
      },
      appAnalyticsEvent: {
        findMany: async () => [],
      },
      pushDevice: {
        findMany: async () => [{ userId: "push1", lastUsedAt: now }],
      },
      refreshToken: {
        findMany: async () => [],
      },
    };

    const engagement = await getAppAnalyticsUserEngagement(db as never, societyId, 30, 50);
    assert.equal(engagement.counts.activeInPeriod, 1);
    assert.equal(engagement.counts.neverUsedApp, 0);
    assert.equal(engagement.neverUsedUsers.length, 0);
  });

  it("returns per-role adoption with user outreach lists", async () => {
    const societyId = "soc1";
    const now = new Date();
    const users = [
      {
        id: "r-active",
        name: "Res Active",
        username: "r_active",
        role: UserRole.RESIDENT,
        isActive: true,
        villa: { villaNumber: "101" },
      },
      {
        id: "r-never",
        name: "Res Never",
        username: "r_never",
        role: UserRole.RESIDENT,
        isActive: true,
        villa: { villaNumber: "102" },
      },
      {
        id: "g-active",
        name: "Guard Active",
        username: "g_active",
        role: UserRole.GUARD,
        isActive: true,
        villa: null,
      },
    ];

    const db = {
      user: {
        findMany: async () => users,
        groupBy: async () => [
          { role: UserRole.RESIDENT, _count: 2 },
          { role: UserRole.GUARD, _count: 1 },
        ],
      },
      appAnalyticsSession: {
        findMany: async (args: { distinct?: string[]; where?: { lastSeenAt?: { gte: Date } } }) => {
          if (args.distinct) return [{ userId: "r-active" }, { userId: "g-active" }];
          if (args.where?.lastSeenAt) {
            return [
              { userId: "r-active", lastSeenAt: now },
              { userId: "g-active", lastSeenAt: now },
            ];
          }
          return [];
        },
      },
      appAnalyticsEvent: {
        findMany: async () => [],
      },
      pushDevice: { findMany: async () => [] },
      refreshToken: { findMany: async () => [] },
    };

    const adoption = await getAppAnalyticsRoleAdoption(db as never, societyId, 30, 20);
    const residents = adoption.roles.find((r) => r.role === UserRole.RESIDENT);
    const guards = adoption.roles.find((r) => r.role === UserRole.GUARD);

    assert.equal(residents?.registered, 2);
    assert.equal(residents?.totalInSociety, 2);
    assert.equal(residents?.active, 1);
    assert.equal(residents?.neverUsed, 1);
    assert.equal(residents?.notUsingAppUsers.neverUsed[0]?.userId, "r-never");
    assert.equal(guards?.active, 1);
    assert.equal(guards?.totalInSociety, 1);
    assert.equal(adoption.meta.totalUsersInDatabase, 3);
    assert.equal(guards?.activeRatePct, 100);
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
