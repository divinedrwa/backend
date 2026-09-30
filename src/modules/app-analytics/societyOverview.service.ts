import { ComplaintStatus, PaymentMode, SOSStatus, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { startOfLocalDayDaysAgo } from "../../lib/societyTime";
import { ADMITTED, INSIDE_NOW, WAITING_NOW } from "../gate-analytics/visitorFilters";
import { loadSupply, minutesOf } from "../water-supply-analytics/loadSupply";
import { longestGapMinutes } from "../water-supply-analytics/supplyIntervals";
import { isWaterTurnedOn } from "../water-supply-analytics/waterEventAction";
import {
  getAppAnalyticsDailyTrend,
  getAppAnalyticsErrors,
  getAppAnalyticsRoleAdoption,
} from "./appAnalytics.service";
import { getBusinessActionCounts } from "./businessActions";

type Db = typeof prisma | Prisma.TransactionClient;

type Tone = "good" | "watch" | "critical" | "neutral";

/** Something the admin should look at now. Ordered critical → warning → info. */
type AttentionItem = {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  /** Analytics tab that explains it: gate | complaints | water | app. */
  area: string;
};

/** One headline card per part of society life. */
type AreaCard = {
  id: "gate" | "complaints" | "dues" | "water" | "app";
  title: string;
  value: string;
  label: string;
  detail: string;
  tone: Tone;
  /** Change vs the previous period of the same length, when comparable. */
  change: { label: string; direction: "up" | "down" | "flat"; good: boolean } | null;
};

/** A self-service feature and how many flats (or requests) use it. */
type FeatureUse = {
  id: string;
  label: string;
  used: number;
  of: number;
  unit: "flats" | "requests";
  pct: number;
  tone: Tone;
  tip: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Open complaints this old are overdue. */
const OVERDUE_DAYS = 7;
/** Unresolved SOS alerts older than this are treated as stale test data. */
const SOS_RECENT_DAYS = 7;
const OPEN_SOS: SOSStatus[] = [
  SOSStatus.CREATED,
  SOSStatus.ACKNOWLEDGED,
  SOSStatus.IN_PROGRESS,
  SOSStatus.PENDING,
  SOSStatus.ACTIVE,
];
const ONLINE_MODES: PaymentMode[] = [PaymentMode.ONLINE, PaymentMode.PHONEPE];

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function toneFor(value: number, good: number, watch: number): Tone {
  if (value >= good) return "good";
  if (value >= watch) return "watch";
  return "critical";
}

/** "1 h 9 min", "45 min", "2 days". */
export function formatDuration(minutes: number): string {
  const m = Math.round(minutes);
  if (m >= 48 * 60) return plural(Math.round(m / (24 * 60)), "day");
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  return `${m} min`;
}

/** Indian grouping, no paise: ₹1,25,000. */
export function formatRupees(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

/** Count change vs the previous period, as a short label. */
export function countChange(
  current: number,
  previous: number,
  higherIsGood = true,
): AreaCard["change"] {
  if (current === previous) {
    return current === 0 ? null : { label: "Same as before", direction: "flat", good: true };
  }
  const direction = current > previous ? "up" : "down";
  const good = higherIsGood ? direction === "up" : direction === "down";
  if (previous === 0) return { label: "New this period", direction, good };
  const change = Math.round((Math.abs(current - previous) / previous) * 100);
  return { label: `${direction === "up" ? "+" : "−"}${change}% vs before`, direction, good };
}

/** Net money received (reversals and their offset rows excluded) and who paid. */
async function paymentsIn(db: Db, societyId: string, from: Date, to: Date) {
  const rows = await db.maintenancePayment.findMany({
    where: {
      societyId,
      paymentDate: { gte: from, lt: to },
      reversedAt: null,
      reversalOfPaymentId: null,
    },
    select: { amount: true, villaId: true, paymentMode: true },
  });
  const flats = new Set(rows.map((r) => r.villaId));
  const onlineFlats = new Set(
    rows.filter((r) => ONLINE_MODES.includes(r.paymentMode)).map((r) => r.villaId),
  );
  return {
    amount: rows.reduce((s, r) => s + Number(r.amount), 0),
    payments: rows.length,
    flats: flats.size,
    onlineFlats: onlineFlats.size,
  };
}

/**
 * One plain-language summary of the society for the Analytics "Overview" tab.
 * Every number uses the same rules as its own tab (gate, complaints, water),
 * over "the last N days including today".
 */
export async function getSocietyOverview(db: Db, societyId: string, days: number) {
  const now = new Date();
  const from = startOfLocalDayDaysAgo(days - 1);
  const prevFrom = new Date(from.getTime() - days * DAY_MS);

  const [
    letIn,
    prevLetIn,
    requests,
    insideNow,
    waitingNow,
    openComplaints,
    filed,
    resolved,
    money,
    prevMoney,
    openSos,
    supply,
    business,
    adoption,
    errors,
    trend,
  ] = await Promise.all([
    db.visitor.count({ where: { societyId, createdAt: { gte: from }, ...ADMITTED } }),
    db.visitor.count({ where: { societyId, createdAt: { gte: prevFrom, lt: from }, ...ADMITTED } }),
    db.visitor.count({ where: { societyId, createdAt: { gte: from } } }),
    db.visitor.count({ where: { societyId, ...INSIDE_NOW } }),
    db.visitor.count({ where: { societyId, ...WAITING_NOW } }),
    db.complaint.findMany({
      where: { societyId, status: { in: [ComplaintStatus.OPEN, ComplaintStatus.IN_PROGRESS] } },
      select: { createdAt: true },
    }),
    db.complaint.count({ where: { societyId, createdAt: { gte: from } } }),
    db.complaint.count({
      where: {
        societyId,
        status: { in: [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED] },
        resolvedAt: { gte: from },
      },
    }),
    paymentsIn(db, societyId, from, now),
    paymentsIn(db, societyId, prevFrom, from),
    db.sOSAlert.count({
      where: {
        societyId,
        status: { in: OPEN_SOS },
        createdAt: { gte: new Date(now.getTime() - SOS_RECENT_DAYS * DAY_MS) },
      },
    }),
    loadSupply(societyId, days),
    getBusinessActionCounts(db, societyId, from, now),
    // These helpers count "N days ago" from the start of that day, so pass N-1.
    getAppAnalyticsRoleAdoption(db, societyId, days - 1, 1),
    getAppAnalyticsErrors(db, societyId, days - 1),
    getAppAnalyticsDailyTrend(db, societyId, Math.min(days, 14)),
  ]);

  // ── Gate ───────────────────────────────────────────────────────────
  const answeredPct = pct(business.gateRequestsAnsweredInApp, business.gateRequests);

  // ── Complaints ─────────────────────────────────────────────────────
  const overdue = openComplaints.filter(
    (c) => now.getTime() - c.createdAt.getTime() > OVERDUE_DAYS * DAY_MS,
  ).length;

  // ── Water ──────────────────────────────────────────────────────────
  const intervals = supply.perGate.flatMap((g) => g.intervals);
  const supplyPerDay = supply.tracked ? minutesOf(intervals) / supply.trackedDays : 0;
  // Once guards stop logging, the time since is unknown — not a dry spell.
  const trackedTo = supply.stale && supply.lastLoggedAt ? supply.lastLoggedAt : now;
  const dryStretch = intervals.length ? longestGapMinutes(intervals, supply.trackedFrom, trackedTo) : null;
  const daysSinceLog = supply.lastLoggedAt
    ? Math.floor((now.getTime() - supply.lastLoggedAt.getTime()) / DAY_MS)
    : null;
  const runningNow = supply.perGate.filter((g) => g.last && isWaterTurnedOn(g.last)).length;

  // ── People ─────────────────────────────────────────────────────────
  const roles = adoption.roles
    .filter((r) => r.registered > 0)
    .map((r) => ({
      role: r.role,
      label: r.label,
      total: r.registered,
      using: r.active,
      stopped: r.dormant,
      never: r.neverUsed,
      usingPct: pct(r.active, r.registered),
    }));
  const people = {
    total: roles.reduce((s, r) => s + r.total, 0),
    using: roles.reduce((s, r) => s + r.using, 0),
    stopped: roles.reduce((s, r) => s + r.stopped, 0),
    never: roles.reduce((s, r) => s + r.never, 0),
  };
  const usingPct = pct(people.using, people.total);

  const areas: AreaCard[] = [
    {
      id: "gate",
      title: "Gate & visitors",
      value: String(letIn),
      label: letIn === 1 ? "person let in" : "people let in",
      detail: `${plural(requests, "gate request")} · ${insideNow} inside now`,
      tone: "neutral",
      change: countChange(letIn, prevLetIn),
    },
    {
      id: "complaints",
      title: "Complaints",
      value: String(openComplaints.length),
      label: openComplaints.length === 1 ? "complaint open" : "complaints open",
      detail: `${filed} filed · ${resolved} resolved in ${days} days`,
      tone: overdue > 0 ? "critical" : openComplaints.length > 0 ? "watch" : "good",
      change: null,
    },
    {
      id: "dues",
      title: "Maintenance",
      value: formatRupees(money.amount),
      label: "received",
      detail:
        money.payments > 0
          ? `${plural(money.flats, "flat")} paid · ${pct(money.onlineFlats, money.flats)}% online`
          : `No payments in ${days} days`,
      tone: "neutral",
      change: countChange(Math.round(money.amount), Math.round(prevMoney.amount)),
    },
    {
      id: "water",
      title: "Water supply",
      value: supply.tracked ? formatDuration(supplyPerDay) : "—",
      label: supply.tracked ? "supply per day" : "not tracked yet",
      detail: !supply.tracked
        ? `Guards haven't logged water ON/OFF in ${days} days.`
        : supply.stale
          ? `Not logged for ${plural(daysSinceLog ?? 0, "day")} — ask guards to tap ON/OFF`
          : runningNow > 0
            ? "Water is running now"
            : dryStretch != null
              ? `Longest without water: ${formatDuration(dryStretch)}`
              : "No supply logged in this period",
      tone: !supply.tracked
        ? "neutral"
        : supply.stale
          ? "watch"
          : dryStretch == null || dryStretch >= 48 * 60
            ? "critical"
            : dryStretch >= 24 * 60
              ? "watch"
              : "good",
      change: null,
    },
    {
      id: "app",
      title: "App usage",
      value: `${people.using} of ${people.total}`,
      label: "people used the app",
      detail:
        people.never > 0
          ? `${plural(people.never, "account")} never opened it`
          : "Everyone has opened the app",
      tone: toneFor(usingPct, 60, 35),
      change: null,
    },
  ];

  // ── Needs attention ────────────────────────────────────────────────
  const attention: AttentionItem[] = [];
  if (openSos > 0) {
    attention.push({
      id: "sos_open",
      severity: "critical",
      title: `${plural(openSos, "emergency alert")} not resolved`,
      detail: "Open the SOS screen and close each alert once it's handled.",
      area: "sos",
    });
  }
  if (overdue > 0) {
    attention.push({
      id: "complaints_overdue",
      severity: "warning",
      title: `${plural(overdue, "complaint")} open for over ${OVERDUE_DAYS} days`,
      detail: "Residents are waiting — assign or resolve the oldest first.",
      area: "complaints",
    });
  }
  if (waitingNow > 0) {
    attention.push({
      id: "visitors_waiting",
      severity: "warning",
      title: `${plural(waitingNow, "visitor")} waiting at the gate`,
      detail: "No resident has replied yet. Guards can call the flat after 3 minutes.",
      area: "gate",
    });
  }
  if (supply.stale && daysSinceLog != null && daysSinceLog < days) {
    attention.push({
      id: "water_not_logged",
      severity: "info",
      title: `Water supply not logged for ${plural(daysSinceLog, "day")}`,
      detail: "Residents only see water updates when guards tap ON/OFF at the gate.",
      area: "water",
    });
  } else if (supply.tracked && dryStretch != null && dryStretch >= 24 * 60) {
    attention.push({
      id: "water_gap",
      severity: "warning",
      title: `No water for ${formatDuration(dryStretch)} at a stretch`,
      detail: "Check with the supplier, or remind guards to log water ON/OFF.",
      area: "water",
    });
  }
  if (business.gateRequests >= 5 && answeredPct < 60) {
    attention.push({
      id: "gate_unanswered",
      severity: "warning",
      title: `Only ${answeredPct}% of gate requests were answered in the app`,
      detail: "Guards had to phone residents for the rest. Ask residents to keep notifications on.",
      area: "gate",
    });
  }
  if (people.total > 0 && pct(people.never, people.total) >= 25) {
    attention.push({
      id: "never_used",
      severity: "info",
      title: `${plural(people.never, "account")} never opened the app`,
      detail: "Share the download link and login help with them.",
      area: "app",
    });
  }
  const errorRate = errors.totals.errorRatePct ?? 0;
  if (errorRate >= 30) {
    const network = pct(errors.totals.networkErrors, errors.totals.events) >= 60;
    attention.push({
      id: "app_errors",
      severity: "info",
      title: `${errorRate}% of app visits hit a problem`,
      detail: network
        ? "Mostly slow or dropped connections, not app bugs."
        : "See the technical details below.",
      area: "app",
    });
  }

  // ── Features ───────────────────────────────────────────────────────
  const flats = business.occupiedFlats;
  const features: FeatureUse[] = [
    {
      id: "pre_approve",
      label: "Invite guests in advance",
      used: business.preApprovalFlats,
      of: flats,
      unit: "flats",
      pct: pct(business.preApprovalFlats, flats),
      tone: toneFor(pct(business.preApprovalFlats, flats), 30, 10),
      tip: "Invited guests walk straight in — no call to the flat.",
    },
    {
      id: "pay_online",
      label: "Pay maintenance online",
      used: money.onlineFlats,
      of: flats,
      unit: "flats",
      pct: pct(money.onlineFlats, flats),
      tone: toneFor(pct(money.onlineFlats, flats), 40, 15),
      tip: "Add the Pay link to the next dues reminder to cut cash collection.",
    },
  ];
  if (business.gateRequests > 0) {
    features.splice(1, 0, {
      id: "answer_in_app",
      label: "Answer gate requests in the app",
      used: business.gateRequestsAnsweredInApp,
      of: business.gateRequests,
      unit: "requests",
      pct: answeredPct,
      tone: toneFor(answeredPct, 75, 50),
      tip: "Each unanswered request means the guard phones the resident.",
    });
  }

  return {
    period: { days, startDate: from.toISOString(), endDate: now.toISOString() },
    attention,
    areas,
    people: { ...people, usingPct, roles },
    features,
    dailyActive: trend.trendData.map((t) => ({
      date: t.date,
      label: shortDay(t.date),
      count: t.activeUsers,
    })),
  };
}

/** "2026-09-30" → "30/9". */
function shortDay(key: string): string {
  const [, m, d] = key.split("-");
  return `${Number(d)}/${Number(m)}`;
}
