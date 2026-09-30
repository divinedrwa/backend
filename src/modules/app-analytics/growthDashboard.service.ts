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
import { getBusinessActionCounts, type BusinessActionCounts } from "./businessActions";

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
  /** "pct" values change in points ("+12 pts"); "count" values in percent ("+40%"). */
  unit?: "pct" | "count";
  /** Ready-to-show change vs the previous period, e.g. "+12 pts" or "−40%". */
  deltaLabel?: string;
  /** True when the metric is better lower (errors), so "up" is bad. */
  lowerIsBetter?: boolean;
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
  const trend: KpiTrend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  if (kpi.unit === "pct") {
    // A rate's change is shown in points — "85% vs 42%" is +43 pts, not "+100%".
    return {
      ...kpi,
      previousValue,
      growthPct: delta,
      trend,
      deltaLabel: delta === 0 ? "No change" : `${sign}${Math.abs(delta)} pts`,
    };
  }
  if (previousValue === 0) {
    return {
      ...kpi,
      previousValue,
      growthPct: kpi.value > 0 ? 100 : 0,
      trend,
      deltaLabel: kpi.value > 0 ? `New (was 0)` : "No change",
    };
  }
  const growthPct = Math.round((delta / Math.abs(previousValue)) * 100);
  return {
    ...kpi,
    previousValue,
    growthPct,
    trend,
    deltaLabel: delta === 0 ? "No change" : `${sign}${Math.abs(growthPct)}%`,
  };
}

/**
 * Lightweight metrics for the period immediately preceding [since, now) — same
 * length, shifted back. Deliberately narrower than the full summary/insights
 * queries: only the fields needed for KPI trend arrows and smart insights.
 */
async function getPreviousPeriodSnapshot(db: Db, societyId: string, days: number, since: Date) {
  const prevStart = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);
  const prevEnd = since;

  const [sessionUserRows, eventUserRows, flowEvents, errorSessionRows, sessionCount, business] =
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
          kind: AppAnalyticsEventKind.ERROR,
          occurredAt: { gte: prevStart, lt: prevEnd },
          sessionId: { not: null },
        },
        select: { sessionId: true },
        distinct: ["sessionId"],
      }),
      db.appAnalyticsSession.count({
        where: { societyId, startedAt: { gte: prevStart, lt: prevEnd } },
      }),
      getBusinessActionCounts(db, societyId, prevStart, prevEnd),
    ]);

  const activeUserIds = new Set<string>([
    ...sessionUserRows.map((r) => r.userId),
    ...eventUserRows.map((r) => r.userId),
  ]);

  const flowSuccessCount = flowEvents.filter((f) => f.success !== false).length;
  const guardFlowSuccessPct = pct(flowSuccessCount, flowEvents.length);

  return {
    activeUserCount: activeUserIds.size,
    guardFlowSuccessPct,
    /** % of sessions with at least one error. */
    errorRatePct: pct(errorSessionRows.length, sessionCount),
    hasSessions: sessionCount > 0,
    business,
  };
}

/** Adoption of a self-service feature among occupied flats. */
type AdoptionLever = {
  action: string;
  label: string;
  pillar: GrowthPillar;
  adoptionPct: number;
  count: number;
  recommendation: string;
};

/** Self-service features, measured from real data, with a plain next step when adoption is low. */
function buildAdoptionLevers(b: BusinessActionCounts): AdoptionLever[] {
  const flats = Math.max(b.occupiedFlats, 1);
  const inAppAnswerPct = pct(b.gateRequestsAnsweredInApp, b.gateRequests);
  const levers: AdoptionLever[] = [
    {
      action: "resident_pre_approve_visitor",
      label: "Guest pre-approvals",
      pillar: "communication",
      adoptionPct: pct(b.preApprovalFlats, flats),
      count: b.preApprovals,
      recommendation: "Remind residents they can invite guests from GatePass+ so the gate lets them in without calls.",
    },
    {
      action: "resident_gate_response",
      label: "Gate requests answered in app",
      pillar: "operations",
      adoptionPct: inAppAnswerPct,
      count: b.gateRequestsAnsweredInApp,
      recommendation: "Ask residents to keep notifications on — unanswered requests make guards phone them.",
    },
    {
      action: "resident_maintenance_payment",
      label: "Online maintenance payments",
      pillar: "monetization",
      adoptionPct: pct(b.onlinePaymentFlats, flats),
      count: b.onlinePayments,
      recommendation: "Share the Pay button in the next dues reminder to cut cash collection.",
    },
  ];
  // Gate-request answering only means something once there were requests.
  return levers.filter((l) => l.action !== "resident_gate_response" || b.gateRequests > 0);
}

/** Auto-generated, plain-language insight sentences from period-over-period deltas. */
function buildSmartInsights(params: {
  days: number;
  prevActiveUserCount: number;
  activeInPeriod: number;
  errorRate: number;
  prevErrorRate: number;
  prevHasSessions: boolean;
  networkErrorShare: number;
  business: BusinessActionCounts;
  prevBusiness: BusinessActionCounts;
  retentionD7: number;
  levers: AdoptionLever[];
  neverUsedApp: number;
  registered: number;
}): SmartInsight[] {
  const insights: SmartInsight[] = [];
  const { days, business: b, prevBusiness: pb } = params;

  const pctChange = (curr: number, prev: number): number | null =>
    prev === 0 ? null : Math.round(((curr - prev) / prev) * 100);

  const activeDelta = pctChange(params.activeInPeriod, params.prevActiveUserCount);
  if (activeDelta !== null && Math.abs(activeDelta) >= 10) {
    insights.push({
      id: "active_users_delta",
      severity: activeDelta > 0 ? "positive" : "warning",
      text: `${params.activeInPeriod} people used the app in the last ${days} days — ${activeDelta > 0 ? "up" : "down"} from ${params.prevActiveUserCount} the period before.`,
    });
  }

  // Errors are judged per session, and network trouble is called out separately.
  if (params.errorRate >= 15) {
    const network = params.networkErrorShare >= 60;
    insights.push({
      id: "errors_high",
      severity: params.errorRate >= 30 ? "critical" : "warning",
      text: network
        ? `${params.errorRate}% of app sessions hit a slow or dropped connection — mostly the server waking up or weak mobile signal, not app bugs.`
        : `${params.errorRate}% of app sessions hit an error — check the error list below.`,
    });
  } else if (params.prevHasSessions && params.prevErrorRate - params.errorRate >= 5) {
    insights.push({
      id: "errors_down",
      severity: "positive",
      text: `Fewer sessions had errors: ${params.errorRate}% now vs ${params.prevErrorRate}% before.`,
    });
  }

  const payDelta = pctChange(b.onlinePayments, pb.onlinePayments);
  if (payDelta !== null && payDelta <= -30) {
    insights.push({
      id: "payments_down",
      severity: "warning",
      text: `Online payments fell to ${b.onlinePayments} from ${pb.onlinePayments} — check the payment gateway and send a reminder.`,
    });
  } else if (payDelta !== null && payDelta >= 30) {
    insights.push({
      id: "payments_up",
      severity: "positive",
      text: `Online payments rose to ${b.onlinePayments} from ${pb.onlinePayments}.`,
    });
  }

  if (b.gateRequests >= 5) {
    const answered = pct(b.gateRequestsAnsweredInApp, b.gateRequests);
    if (answered < 60) {
      insights.push({
        id: "gate_unanswered",
        severity: "warning",
        text: `Residents answered only ${answered}% of gate requests in the app — guards had to call or wait for the rest.`,
      });
    }
  }

  if (params.retentionD7 > 0 && params.retentionD7 < 20) {
    insights.push({
      id: "retention_low",
      severity: "warning",
      text: `Only ${params.retentionD7}% of users came back within a week.`,
    });
  }

  const neverUsedPct = pct(params.neverUsedApp, params.registered);
  if (neverUsedPct >= 25 && params.registered > 0) {
    insights.push({
      id: "never_used_high",
      severity: "warning",
      text: `${params.neverUsedApp} of ${params.registered} accounts (${neverUsedPct}%) have never opened the app — share the download link and login help.`,
    });
  }

  for (const lever of params.levers.filter((l) => l.adoptionPct < 30).slice(0, 2)) {
    insights.push({
      id: `low_adoption_${lever.action}`,
      severity: "info",
      text: `${lever.label}: ${lever.adoptionPct}% of flats. ${lever.recommendation}`,
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

  const [summary, insights, flowsPayload, errorsPayload, roleAdoption, previous, business] =
    await Promise.all([
      getAppAnalyticsSummary(db, societyId, days),
      getAppAnalyticsInsights(db, societyId, days),
      getAppAnalyticsFlows(db, societyId, days),
      getAppAnalyticsErrors(db, societyId, days),
      getAppAnalyticsRoleAdoption(db, societyId, days, 0),
      getPreviousPeriodSnapshot(db, societyId, days, since),
      getBusinessActionCounts(db, societyId, since),
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

  const guardFlows = flowsPayload.flows;
  const avgGuardSuccess =
    guardFlows.length > 0
      ? Math.round(guardFlows.reduce((sum, f) => sum + f.successRate, 0) / guardFlows.length)
      : 0;

  const errorRate = errorsPayload.totals.errorRatePct ?? 0;
  const errorFree = errorsPayload.totals.errorFreeSessionPct ?? 100;
  const networkErrorShare = pct(errorsPayload.totals.networkErrors, errorsPayload.totals.events);
  const levers = buildAdoptionLevers(business);
  const flats = Math.max(business.occupiedFlats, 1);
  const prevFlats = Math.max(previous.business.occupiedFlats, 1);

  // Health = activation, weekly stickiness, 7-day return and error-free sessions.
  const healthScore = Math.min(
    100,
    Math.round(
      activationRate * 0.25 +
        (stickiness.wauMauPct ?? 0) * 0.25 +
        (retention.d7Pct ?? 0) * 0.25 +
        errorFree * 0.25,
    ),
  );

  // Flats that did at least one self-service action ≈ "key action" reach.
  const keyActionFlats = Math.min(
    flats,
    Math.max(business.preApprovalFlats, business.onlinePaymentFlats),
  );

  const kpis: GrowthKpi[] = [
    {
      id: "health_score",
      label: "App health",
      value: healthScore,
      displayValue: `${healthScore}/100`,
      pillar: "engagement",
      status: statusFromPct(healthScore, 70, 45),
      hint: "Blend of accounts activated, weekly return, 7-day return and error-free sessions.",
    },
    {
      id: "activation_rate",
      label: "Accounts that use the app",
      value: activationRate,
      displayValue: `${activationRate}%`,
      unit: "pct",
      pillar: "acquisition",
      status: statusFromPct(activationRate, 75, 50),
      hint: `${everUsed} of ${registered} accounts have opened the app at least once.`,
    },
    withTrend(
      {
        id: "active_rate",
        label: `Active in last ${days} days`,
        value: activeRate,
        displayValue: `${activeRate}%`,
        unit: "pct",
        pillar: "engagement",
        status: statusFromPct(activeRate, 60, 35),
        hint: `${engagement.activeInPeriod} of ${registered} accounts, vs the previous ${days} days.`,
      },
      pct(previous.activeUserCount, registered),
    ),
    {
      id: "stickiness",
      label: "Weekly return (WAU/MAU)",
      value: stickiness.wauMauPct ?? 0,
      displayValue: `${stickiness.wauMauPct ?? 0}%`,
      unit: "pct",
      pillar: "engagement",
      status: statusFromPct(stickiness.wauMauPct ?? 0, 60, 35),
      hint: "Of people active this month, how many also used it this week.",
    },
    {
      id: "retention_d7",
      label: "7-day return",
      value: retention.d7Pct ?? 0,
      displayValue: `${retention.d7Pct ?? 0}%`,
      unit: "pct",
      pillar: "engagement",
      status: statusFromPct(retention.d7Pct ?? 0, 40, 20),
      hint: "Users who joined 7+ days ago and came back this week.",
    },
    withTrend(
      {
        id: "error_free_sessions",
        label: "Sessions without errors",
        value: errorFree,
        displayValue: `${errorFree}%`,
        unit: "pct",
        pillar: "operations",
        status: statusFromPct(errorFree, 90, 75),
        hint:
          networkErrorShare >= 60
            ? "Most errors are slow/dropped connections (server waking up, weak signal)."
            : "App sessions that finished without any error.",
      },
      previous.hasSessions ? 100 - previous.errorRatePct : undefined,
    ),
    withTrend(
      {
        id: "pre_approvals",
        label: "Guest pre-approvals",
        value: business.preApprovals,
        displayValue: `${business.preApprovals}`,
        unit: "count",
        pillar: "communication",
        status: pct(business.preApprovalFlats, flats) >= 20 ? "good" : "watch",
        hint: `${business.preApprovalFlats} of ${business.occupiedFlats} flats invited guests in advance.`,
      },
      previous.business.preApprovals,
    ),
    withTrend(
      {
        id: "maintenance_payments",
        label: "Online payments",
        value: business.onlinePayments,
        displayValue: `${business.onlinePayments}`,
        unit: "count",
        pillar: "monetization",
        status: pct(business.onlinePaymentFlats, flats) >= 30 ? "good" : "watch",
        hint: `${business.onlinePaymentFlats} of ${business.occupiedFlats} flats paid maintenance online (vs ${pct(previous.business.onlinePaymentFlats, prevFlats)}% before).`,
      },
      previous.business.onlinePayments,
    ),
  ];
  if (business.gateRequests > 0) {
    kpis.push(
      withTrend(
        {
          id: "gate_answered_in_app",
          label: "Gate requests answered in app",
          value: pct(business.gateRequestsAnsweredInApp, business.gateRequests),
          displayValue: `${pct(business.gateRequestsAnsweredInApp, business.gateRequests)}%`,
          unit: "pct",
          pillar: "operations",
          status: statusFromPct(pct(business.gateRequestsAnsweredInApp, business.gateRequests), 75, 50),
          hint: `${business.gateRequestsAnsweredInApp} of ${business.gateRequests} flat requests got a resident reply in the app.`,
        },
        previous.business.gateRequests > 0
          ? pct(previous.business.gateRequestsAnsweredInApp, previous.business.gateRequests)
          : undefined,
      ),
    );
  }

  const smartInsights = buildSmartInsights({
    days,
    prevActiveUserCount: previous.activeUserCount,
    activeInPeriod: engagement.activeInPeriod,
    errorRate,
    prevErrorRate: previous.errorRatePct,
    prevHasSessions: previous.hasSessions,
    networkErrorShare,
    business,
    prevBusiness: previous.business,
    retentionD7: retention.d7Pct ?? 0,
    levers,
    neverUsedApp: engagement.neverUsedApp,
    registered,
  });

  const funnel = [
    { stage: "Registered accounts", count: registered, ratePct: 100 },
    { stage: "Ever used app", count: everUsed, ratePct: activationRate },
    { stage: `Active (${days}d)`, count: engagement.activeInPeriod, ratePct: activeRate },
    {
      stage: "Flats using self-service",
      count: keyActionFlats,
      ratePct: pct(keyActionFlats, flats),
    },
  ];

  const pillars = {
    acquisition: {
      registered,
      everUsed,
      neverUsed: engagement.neverUsedApp,
      activationRatePct: activationRate,
    },
    engagement: {
      dailyActiveUsers: totals.dailyActiveUsers,
      weeklyActiveUsers: totals.weeklyActiveUsers,
      monthlyActiveUsers: totals.monthlyActiveUsers,
      stickinessPct: stickiness.stickinessPct,
      wauMauPct: stickiness.wauMauPct,
      retentionD7Pct: retention.d7Pct,
      retentionD30Pct: retention.d30Pct,
      activeInPeriod: engagement.activeInPeriod,
      dormant: engagement.inactiveInPeriod,
    },
    operations: {
      guardFlowCompletions: totals.flowCompletions,
      guardFlowSuccessPct: avgGuardSuccess,
      errorRatePct: errorRate,
      errorFreeSessionPct: errorFree,
      networkErrors: errorsPayload.totals.networkErrors,
      appErrors: errorsPayload.totals.appErrors,
      sessions: totals.sessions,
      gateEntries: business.gateEntries,
      parcels: business.parcels,
    },
    monetization: {
      maintenancePayments: business.onlinePayments,
      paymentAdoptionPct: pct(business.onlinePaymentFlats, flats),
      billingCyclesPublished:
        actions.actions.find((a) => a.action === "admin_billing_cycle_publish")?.count ?? 0,
    },
    communication: {
      preApprovals: business.preApprovals,
      complaints: business.complaints,
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
    growthLevers: levers.filter((l) => l.adoptionPct < 50),
    catalog: BUSINESS_ACTION_CATALOG,
  };
}
