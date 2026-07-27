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
type KpiTrend = "up" | "down" | "flat";

type GrowthKpi = {
  id: string;
  label: string;
  value: number;
  displayValue: string;
  pillar: GrowthPillar;
  status: KpiStatus;
  hint: string;
  /** Same metric computed for the immediately preceding period of equal length, when comparable. */
  previousValue?: number;
  /** Percentage-point or relative growth vs previousValue — sign indicates direction. */
  growthPct?: number;
  trend?: KpiTrend;
};

type InsightSeverity = "positive" | "warning" | "critical" | "info";

type SmartInsight = {
  id: string;
  severity: InsightSeverity;
  text: string;
};

function statusFromPct(pct: number, goodMin: number, watchMin: number): KpiStatus {
  if (pct >= goodMin) return "good";
  if (pct >= watchMin) return "watch";
  return "critical";
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

/** Attaches previousValue/growthPct/trend to a KPI when a comparable prior value exists. */
function withTrend(kpi: GrowthKpi, previousValue: number | undefined): GrowthKpi {
  if (previousValue === undefined) return kpi;
  const delta = kpi.value - previousValue;
  const growthPct =
    previousValue !== 0
      ? Math.round((delta / Math.abs(previousValue)) * 100)
      : kpi.value > 0
        ? 100
        : 0;
  const trend: KpiTrend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return { ...kpi, previousValue, growthPct, trend };
}

/**
 * Lightweight metrics for the period immediately preceding [since, now) — same
 * length, shifted back. Deliberately narrower than the full summary/insights
 * queries: only the fields needed for KPI trend arrows and smart insights.
 */
async function getPreviousPeriodSnapshot(db: Db, societyId: string, days: number, since: Date) {
  const prevStart = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);
  const prevEnd = since;

  const [sessionUserRows, eventUserRows, flowEvents, actionAndErrorEvents, paymentCount, preApprovalCount] =
    await Promise.all([
      db.appAnalyticsSession.findMany({
        where: { societyId, startedAt: { gte: prevStart, lt: prevEnd } },
        select: { userId: true },
        distinct: ["userId"],
      }),
      db.appAnalyticsEvent.findMany({
        where: { societyId, occurredAt: { gte: prevStart, lt: prevEnd } },
        select: { userId: true },
        distinct: ["userId"],
      }),
      db.appAnalyticsEvent.findMany({
        where: {
          societyId,
          kind: AppAnalyticsEventKind.FLOW_COMPLETE,
          occurredAt: { gte: prevStart, lt: prevEnd },
        },
        select: { success: true },
      }),
      db.appAnalyticsEvent.findMany({
        where: {
          societyId,
          kind: { in: [AppAnalyticsEventKind.ACTION, AppAnalyticsEventKind.ERROR] },
          occurredAt: { gte: prevStart, lt: prevEnd },
        },
        select: { kind: true, userId: true },
      }),
      db.appAnalyticsEvent.count({
        where: {
          societyId,
          kind: AppAnalyticsEventKind.ACTION,
          name: "resident_maintenance_payment",
          occurredAt: { gte: prevStart, lt: prevEnd },
        },
      }),
      db.appAnalyticsEvent.count({
        where: {
          societyId,
          kind: AppAnalyticsEventKind.ACTION,
          name: "resident_pre_approve_visitor",
          occurredAt: { gte: prevStart, lt: prevEnd },
        },
      }),
    ]);

  const activeUserIds = new Set<string>([
    ...sessionUserRows.map((r) => r.userId),
    ...eventUserRows.map((r) => r.userId),
  ]);

  const flowSuccessCount = flowEvents.filter((f) => f.success !== false).length;
  const guardFlowSuccessPct = pct(flowSuccessCount, flowEvents.length);

  const actionEvents = actionAndErrorEvents.filter((e) => e.kind === AppAnalyticsEventKind.ACTION);
  const errorEvents = actionAndErrorEvents.filter((e) => e.kind === AppAnalyticsEventKind.ERROR);
  const errorRatePct = pct(errorEvents.length, actionEvents.length + errorEvents.length);
  const keyActionUserCount = new Set(actionEvents.map((e) => e.userId)).size;

  return {
    activeUserCount: activeUserIds.size,
    guardFlowSuccessPct,
    errorRatePct,
    keyActionUserCount,
    maintenancePayments: paymentCount,
    preApprovals: preApprovalCount,
  };
}

/** Auto-generated, plain-language insight sentences from period-over-period deltas. */
function buildSmartInsights(params: {
  days: number;
  activeRate: number;
  prevActiveUserCount: number;
  activeInPeriod: number;
  errorRate: number;
  prevErrorRate: number;
  avgGuardSuccess: number;
  prevGuardSuccess: number;
  paymentCount: number;
  prevPaymentCount: number;
  preApprovalCount: number;
  prevPreApprovalCount: number;
  retentionD7: number;
  growthLevers: { label: string; adoptionPct: number }[];
  neverUsedApp: number;
  registered: number;
}): SmartInsight[] {
  const insights: SmartInsight[] = [];
  const {
    days,
    prevActiveUserCount,
    activeInPeriod,
    errorRate,
    prevErrorRate,
    avgGuardSuccess,
    prevGuardSuccess,
    paymentCount,
    prevPaymentCount,
    preApprovalCount,
    prevPreApprovalCount,
    retentionD7,
    growthLevers,
    neverUsedApp,
    registered,
  } = params;

  const pctChange = (curr: number, prev: number): number | null => {
    if (prev === 0) return curr > 0 ? 100 : null;
    return Math.round(((curr - prev) / prev) * 100);
  };

  const activeUsersDelta = pctChange(activeInPeriod, prevActiveUserCount);
  if (activeUsersDelta !== null && Math.abs(activeUsersDelta) >= 10) {
    insights.push({
      id: "active_users_delta",
      severity: activeUsersDelta > 0 ? "positive" : "warning",
      text: `Active users ${activeUsersDelta > 0 ? "grew" : "dropped"} ${Math.abs(activeUsersDelta)}% vs the previous ${days}-day period.`,
    });
  }

  if (errorRate > prevErrorRate && errorRate - prevErrorRate >= 3) {
    insights.push({
      id: "error_rate_up",
      severity: "critical",
      text: `Error rate rose from ${prevErrorRate}% to ${errorRate}% — investigate recent releases or failing flows.`,
    });
  } else if (prevErrorRate > errorRate && prevErrorRate - errorRate >= 3) {
    insights.push({
      id: "error_rate_down",
      severity: "positive",
      text: `Error rate improved from ${prevErrorRate}% to ${errorRate}%.`,
    });
  }

  if (prevGuardSuccess > 0 && avgGuardSuccess < prevGuardSuccess && prevGuardSuccess - avgGuardSuccess >= 5) {
    insights.push({
      id: "guard_success_down",
      severity: "warning",
      text: `Guard flow success rate dropped ${prevGuardSuccess - avgGuardSuccess}pp (${prevGuardSuccess}% → ${avgGuardSuccess}%) — check gate operations.`,
    });
  }

  const paymentDelta = pctChange(paymentCount, prevPaymentCount);
  if (paymentDelta !== null && paymentDelta <= -20 && prevPaymentCount > 0) {
    insights.push({
      id: "payments_down",
      severity: "critical",
      text: `Online maintenance payments dropped ${Math.abs(paymentDelta)}% vs the previous period — check payment gateway health.`,
    });
  } else if (paymentDelta !== null && paymentDelta >= 20 && prevPaymentCount > 0) {
    insights.push({
      id: "payments_up",
      severity: "positive",
      text: `Online maintenance payments grew ${paymentDelta}% vs the previous period.`,
    });
  }

  const preApprovalDelta = pctChange(preApprovalCount, prevPreApprovalCount);
  if (preApprovalDelta !== null && preApprovalDelta >= 20 && prevPreApprovalCount > 0) {
    insights.push({
      id: "pre_approvals_up",
      severity: "positive",
      text: `Visitor pre-approvals grew ${preApprovalDelta}% — residents are adopting self-service gate entry.`,
    });
  }

  if (retentionD7 > 0 && retentionD7 < 20) {
    insights.push({
      id: "retention_low",
      severity: "warning",
      text: `7-day retention is only ${retentionD7}% — most users aren't coming back within a week.`,
    });
  }

  const neverUsedPct = pct(neverUsedApp, registered);
  if (neverUsedPct >= 40 && registered > 0) {
    insights.push({
      id: "never_used_high",
      severity: "warning",
      text: `${neverUsedPct}% of registered accounts (${neverUsedApp} of ${registered}) have never opened the app.`,
    });
  }

  for (const lever of growthLevers.slice(0, 2)) {
    insights.push({
      id: `low_adoption_${lever.label}`,
      severity: "info",
      text: `"${lever.label}" has only ${lever.adoptionPct}% adoption — consider promoting it in notices or onboarding.`,
    });
  }

  if (insights.length === 0) {
    insights.push({
      id: "steady",
      severity: "info",
      text: "No significant changes vs the previous period — usage is steady.",
    });
  }

  return insights;
}

/**
 * Unified business-growth dashboard: custom server analytics (primary) with Firebase
 * mirror metadata. The app dual-writes the same events to GA4; this endpoint is the
 * society-scoped source of truth for admin decisions.
 */
export async function getAppAnalyticsGrowthDashboard(db: Db, societyId: string, days: number) {
  const since = startOfLocalDayDaysAgo(days);

  const [summary, insights, flowsPayload, errorsPayload, roleAdoption, previous] = await Promise.all([
    getAppAnalyticsSummary(db, societyId, days),
    getAppAnalyticsInsights(db, societyId, days),
    getAppAnalyticsFlows(db, societyId, days),
    getAppAnalyticsErrors(db, societyId, days),
    getAppAnalyticsRoleAdoption(db, societyId, days, 0),
    getPreviousPeriodSnapshot(db, societyId, days, since),
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
    withTrend(
      {
        id: "active_rate",
        label: "Active this period",
        value: activeRate,
        displayValue: `${activeRate}%`,
        pillar: "engagement",
        status: statusFromPct(activeRate, 60, 35),
        hint: `Users active in the last ${days} days, vs the previous ${days}-day period.`,
      },
      pct(previous.activeUserCount, registered),
    ),
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
    withTrend(
      {
        id: "guard_success",
        label: "Guard flow success",
        value: avgGuardSuccess,
        displayValue: `${avgGuardSuccess}%`,
        pillar: "operations",
        status: statusFromPct(avgGuardSuccess, 90, 75),
        hint: "Average success rate across gate workflows, vs the previous period.",
      },
      previous.guardFlowSuccessPct,
    ),
    withTrend(
      {
        id: "maintenance_payments",
        label: "Maintenance payments",
        value: paymentAction?.count ?? 0,
        displayValue: `${paymentAction?.count ?? 0}`,
        pillar: "monetization",
        status: (paymentAction?.count ?? 0) > 0 ? "good" : "watch",
        hint: "Online payment completions in period, vs the previous period.",
      },
      previous.maintenancePayments,
    ),
    withTrend(
      {
        id: "pre_approvals",
        label: "Visitor pre-approvals",
        value: preApproveAction?.count ?? 0,
        displayValue: `${preApproveAction?.count ?? 0}`,
        pillar: "communication",
        status: (preApproveAction?.count ?? 0) > 0 ? "good" : "watch",
        hint: "Resident-driven gate entries enabled, vs the previous period.",
      },
      previous.preApprovals,
    ),
  ];

  const smartInsights = buildSmartInsights({
    days,
    activeRate,
    prevActiveUserCount: previous.activeUserCount,
    activeInPeriod: engagement.activeInPeriod,
    errorRate,
    prevErrorRate: previous.errorRatePct,
    avgGuardSuccess,
    prevGuardSuccess: previous.guardFlowSuccessPct,
    paymentCount: paymentAction?.count ?? 0,
    prevPaymentCount: previous.maintenancePayments,
    preApprovalCount: preApproveAction?.count ?? 0,
    prevPreApprovalCount: previous.preApprovals,
    retentionD7: retention.d7Pct ?? 0,
    growthLevers: actions.actions
      .filter((a) => a.adoptionPct < 40)
      .slice(0, 5)
      .map((a) => ({ label: a.label, adoptionPct: a.adoptionPct })),
    neverUsedApp: engagement.neverUsedApp,
    registered,
  });

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
    smartInsights,
    funnel,
    pillars,
    growthLevers,
    catalog: BUSINESS_ACTION_CATALOG,
  };
}
