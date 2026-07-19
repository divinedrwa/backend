import type { Prisma } from "@prisma/client";
import { AppAnalyticsEventKind } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { startOfLocalDayDaysAgo } from "../../lib/societyTime";
import {
  ANALYTICS_DATA_SOURCES,
  BUSINESS_ACTION_CATALOG,
  FIREBASE_FREE_TIER_METRICS,
  FIREBASE_MIRRORED_EVENTS,
  type GrowthPillar,
} from "./analyticsCatalog";
import {
  getAppAnalyticsActions,
  getAppAnalyticsErrors,
  getAppAnalyticsFlows,
  getAppAnalyticsInsights,
  getAppAnalyticsRoleAdoption,
  getAppAnalyticsSummary,
} from "./appAnalytics.service";

type Db = typeof prisma | Prisma.TransactionClient;

type KpiStatus = "good" | "watch" | "critical";

type GrowthKpi = {
  id: string;
  label: string;
  value: number;
  displayValue: string;
  pillar: GrowthPillar;
  status: KpiStatus;
  hint: string;
};

function statusFromPct(pct: number, goodMin: number, watchMin: number): KpiStatus {
  if (pct >= goodMin) return "good";
  if (pct >= watchMin) return "watch";
  return "critical";
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

/**
 * Unified business-growth dashboard: custom server analytics (primary) with Firebase
 * mirror metadata. The app dual-writes the same events to GA4; this endpoint is the
 * society-scoped source of truth for admin decisions.
 */
export async function getAppAnalyticsGrowthDashboard(db: Db, societyId: string, days: number) {
  const since = startOfLocalDayDaysAgo(days);

  const [summary, insights, flowsPayload, errorsPayload, roleAdoption] = await Promise.all([
    getAppAnalyticsSummary(db, societyId, days),
    getAppAnalyticsInsights(db, societyId, days),
    getAppAnalyticsFlows(db, societyId, days),
    getAppAnalyticsErrors(db, societyId, days),
    getAppAnalyticsRoleAdoption(db, societyId, days, 0),
  ]);

  const engagement = summary.engagement;
  const registered = engagement.registeredActiveAccounts;
  const actions = await getAppAnalyticsActions(db, societyId, days, registered);

  const totals = summary.totals;
  const stickiness = insights.stickiness;
  const retention = insights.retention;

  const everUsed = registered - engagement.neverUsedApp;
  const activationRate = pct(everUsed, registered);
  const activeRate = pct(engagement.activeInPeriod, registered);

  const actionUserRows = await db.appAnalyticsEvent.findMany({
    where: {
      societyId,
      kind: AppAnalyticsEventKind.ACTION,
      occurredAt: { gte: since },
    },
    select: { userId: true },
    distinct: ["userId"],
  });
  const keyActionUserCount = actionUserRows.length;
  const keyActionRate = pct(keyActionUserCount, registered);

  const guardFlows = flowsPayload.flows;
  const avgGuardSuccess =
    guardFlows.length > 0
      ? Math.round(
          guardFlows.reduce((sum, f) => sum + f.successRate, 0) / guardFlows.length,
        )
      : 0;

  const paymentAction = actions.actions.find((a) => a.action === "resident_maintenance_payment");
  const preApproveAction = actions.actions.find((a) => a.action === "resident_pre_approve_visitor");

  const errorRate = errorsPayload.totals.errorRatePct ?? 0;

  const healthScore = Math.min(
    100,
    Math.round(
      activationRate * 0.25 +
        (stickiness.stickinessPct ?? 0) * 0.25 +
        (retention.d7Pct ?? 0) * 0.25 +
        Math.max(0, 100 - errorRate) * 0.25,
    ),
  );

  const kpis: GrowthKpi[] = [
    {
      id: "health_score",
      label: "Growth health",
      value: healthScore,
      displayValue: `${healthScore}/100`,
      pillar: "engagement",
      status: statusFromPct(healthScore, 70, 45),
      hint: "Blend of activation, stickiness, retention, and reliability.",
    },
    {
      id: "activation_rate",
      label: "Activation rate",
      value: activationRate,
      displayValue: `${activationRate}%`,
      pillar: "acquisition",
      status: statusFromPct(activationRate, 75, 50),
      hint: "Registered accounts with any app usage signal (analytics, push, or login).",
    },
    {
      id: "active_rate",
      label: "Active this period",
      value: activeRate,
      displayValue: `${activeRate}%`,
      pillar: "engagement",
      status: statusFromPct(activeRate, 60, 35),
      hint: `Users active in the last ${days} days.`,
    },
    {
      id: "stickiness",
      label: "Stickiness (DAU/MAU)",
      value: stickiness.stickinessPct ?? 0,
      displayValue: `${stickiness.stickinessPct ?? 0}%`,
      pillar: "engagement",
      status: statusFromPct(stickiness.stickinessPct ?? 0, 25, 12),
      hint: "Higher means users return daily within the month.",
    },
    {
      id: "retention_d7",
      label: "7-day retention",
      value: retention.d7Pct ?? 0,
      displayValue: `${retention.d7Pct ?? 0}%`,
      pillar: "engagement",
      status: statusFromPct(retention.d7Pct ?? 0, 40, 20),
      hint: "Users who joined 7+ days ago and returned this week.",
    },
    {
      id: "guard_success",
      label: "Guard flow success",
      value: avgGuardSuccess,
      displayValue: `${avgGuardSuccess}%`,
      pillar: "operations",
      status: statusFromPct(avgGuardSuccess, 90, 75),
      hint: "Average success rate across gate workflows.",
    },
    {
      id: "maintenance_payments",
      label: "Maintenance payments",
      value: paymentAction?.count ?? 0,
      displayValue: `${paymentAction?.count ?? 0}`,
      pillar: "monetization",
      status: (paymentAction?.count ?? 0) > 0 ? "good" : "watch",
      hint: "Online payment completions in period.",
    },
    {
      id: "pre_approvals",
      label: "Visitor pre-approvals",
      value: preApproveAction?.count ?? 0,
      displayValue: `${preApproveAction?.count ?? 0}`,
      pillar: "communication",
      status: (preApproveAction?.count ?? 0) > 0 ? "good" : "watch",
      hint: "Resident-driven gate entries enabled.",
    },
  ];

  const funnel = [
    { stage: "Registered accounts", count: registered, ratePct: 100 },
    { stage: "Ever used app", count: everUsed, ratePct: activationRate },
    { stage: `Active (${days}d)`, count: engagement.activeInPeriod, ratePct: activeRate },
    { stage: "Key business action", count: keyActionUserCount, ratePct: keyActionRate },
  ];

  const growthLevers = actions.actions
    .filter((a) => a.adoptionPct < 40)
    .slice(0, 5)
    .map((a) => {
      const catalog = BUSINESS_ACTION_CATALOG.find((c) => c.id === a.action);
      return {
        action: a.action,
        label: a.label,
        pillar: catalog?.pillar ?? "engagement",
        adoptionPct: a.adoptionPct,
        count: a.count,
        recommendation:
          a.adoptionPct < 15
            ? "Low adoption — promote in notices or onboarding."
            : "Moderate adoption — room to grow with reminders.",
      };
    });

  const pillars = {
    acquisition: {
      registered,
      everUsed,
      neverUsed: engagement.neverUsedApp,
      activationRatePct: activationRate,
    },
    engagement: {
      dailyActiveUsers: totals.dailyActiveUsers,
      monthlyActiveUsers: totals.monthlyActiveUsers,
      stickinessPct: stickiness.stickinessPct,
      retentionD7Pct: retention.d7Pct,
      retentionD30Pct: retention.d30Pct,
      activeInPeriod: engagement.activeInPeriod,
      dormant: engagement.inactiveInPeriod,
    },
    operations: {
      guardFlowCompletions: totals.flowCompletions,
      guardFlowSuccessPct: avgGuardSuccess,
      errorRatePct: errorRate,
      sessions: totals.sessions,
    },
    monetization: {
      maintenancePayments: paymentAction?.count ?? 0,
      paymentAdoptionPct: paymentAction?.adoptionPct ?? 0,
      billingCyclesPublished:
        actions.actions.find((a) => a.action === "admin_billing_cycle_publish")?.count ?? 0,
    },
    communication: {
      preApprovals: preApproveAction?.count ?? 0,
      complaints:
        actions.actions.find((a) => a.action === "resident_complaint_submit")?.count ?? 0,
      noticesPublished:
        actions.actions.find((a) => a.action === "admin_notice_publish")?.count ?? 0,
    },
  };

  return {
    period: { days, startDate: since.toISOString(), endDate: new Date().toISOString() },
    dataSources: ANALYTICS_DATA_SOURCES,
    firebaseMirroredEvents: FIREBASE_MIRRORED_EVENTS,
    firebaseFreeMetrics: FIREBASE_FREE_TIER_METRICS,
    roleAdoption: roleAdoption.roles,
    healthScore,
    kpis,
    funnel,
    pillars,
    growthLevers,
    catalog: BUSINESS_ACTION_CATALOG,
  };
}
