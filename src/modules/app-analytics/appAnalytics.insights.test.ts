import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppAnalyticsEventKind, UserRole } from "@prisma/client";
import {
  BUSINESS_ACTION_LABELS,
  getAppAnalyticsActions,
  getAppAnalyticsErrors,
  getAppAnalyticsInsights,
} from "./appAnalytics.service.js";

describe("appAnalytics enterprise metrics", () => {
  it("labels known business actions", () => {
    assert.equal(BUSINESS_ACTION_LABELS.resident_pre_approve_visitor, "Pre-approve visitor");
    assert.equal(BUSINESS_ACTION_LABELS.admin_notice_publish, "Publish notice");
  });

  it("aggregates actions with adoption rate", async () => {
    const fakeDb = {
      appAnalyticsEvent: {
        findMany: async () => [
          {
            name: "resident_pre_approve_visitor",
            userId: "u1",
            role: UserRole.RESIDENT,
            occurredAt: new Date(),
          },
          {
            name: "resident_pre_approve_visitor",
            userId: "u1",
            role: UserRole.RESIDENT,
            occurredAt: new Date(),
          },
          {
            name: "resident_complaint_submit",
            userId: "u2",
            role: UserRole.RESIDENT,
            occurredAt: new Date(),
          },
        ],
      },
    };

    const result = await getAppAnalyticsActions(fakeDb as never, "soc1", 30, 10);
    assert.equal(result.totals.events, 3);
    assert.equal(result.actions[0]?.action, "resident_pre_approve_visitor");
    assert.equal(result.actions[0]?.count, 2);
    assert.equal(result.actions[0]?.uniqueUsers, 1);
    assert.equal(result.actions[0]?.adoptionPct, 10);
    assert.equal(result.actions[0]?.label, "Pre-approve visitor");
  });

  it("aggregates errors with error rate", async () => {
    const fakeDb = {
      appAnalyticsEvent: {
        findMany: async () => [
          {
            name: "api_timeout",
            userId: "u1",
            role: UserRole.GUARD,
            occurredAt: new Date(),
            appVersion: "1.0.0",
          },
        ],
      },
      appAnalyticsSession: {
        count: async () => 4,
      },
    };

    const result = await getAppAnalyticsErrors(fakeDb as never, "soc1", 30);
    assert.equal(result.totals.events, 1);
    assert.equal(result.totals.errorRatePct, 25);
    assert.equal(result.errors[0]?.error, "api_timeout");
  });

  it("computes stickiness and retention insights", async () => {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 8 * 86_400_000);
    const fakeDb = {
      appAnalyticsSession: {
        findMany: async () => [
          {
            userId: "u1",
            startedAt: weekAgo,
            lastSeenAt: now,
            role: UserRole.RESIDENT,
          },
        ],
        groupBy: async () => [{ userId: "u1", _min: { startedAt: weekAgo } }],
      },
      appAnalyticsEvent: {
        findMany: async () => [
          {
            userId: "u1",
            occurredAt: now,
            role: UserRole.RESIDENT,
            kind: AppAnalyticsEventKind.LOGIN,
          },
        ],
      },
    };

    const insights = await getAppAnalyticsInsights(fakeDb as never, "soc1", 30);
    assert.ok(insights.stickiness.monthlyActiveUsers >= 1);
    assert.ok(Array.isArray(insights.hourlyData));
    assert.equal(insights.hourlyData.length, 24);
  });
});
