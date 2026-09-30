import { SOSStatus } from "@prisma/client";
import { getBusinessActionCounts } from "./businessActions";
import {
  type Change,
  type Db,
  type Tone,
  DAY_MS,
  countChange,
  formatDuration,
  formatRupees,
  pct,
  periodFor,
  plural,
  toneFor,
} from "./overview/common";
import { buildGate, buildSecurity, OPEN_SOS } from "./overview/gateSecurity";
import { buildGrowth } from "./overview/growth";
import { buildMoney } from "./overview/money";
import { buildPeopleAndApp } from "./overview/peopleApp";
import { buildService, OVERDUE_DAYS } from "./overview/service";
import { buildWeeklySummary } from "./overview/summary";
import { buildWater } from "./overview/water";

export { countChange, formatDuration, formatRupees };

/** Something the admin should act on. Ordered critical → warning → info. */
type AttentionItem = {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  /** Screen that explains it: gate | complaints | water | dues | sos | app | amenities. */
  area: string;
  /** Outreach list with the people to contact, when there is one. */
  list?: "duesPending" | "neverOpened" | "cantGetAlerts" | "flatsWithoutApp" | "regularVisitors";
};

/** One headline card per part of society life. */
type AreaCard = {
  id: "gate" | "complaints" | "dues" | "water" | "app";
  title: string;
  value: string;
  label: string;
  detail: string;
  tone: Tone;
  change: Change;
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

/** Unresolved SOS alerts older than this are treated as stale test data. */
const SOS_RECENT_DAYS = 7;

/**
 * Everything an admin needs to run and grow the society, in plain language:
 * what needs attention, money, gate & security, service, people & app, growth
 * and who to contact. Numbers use the same rules as their own screens, over
 * "the last N days including today".
 */
export async function getSocietyOverview(db: Db, societyId: string, days: number) {
  const p = periodFor(days);

  const [money, gate, security, service, water, pa, growth, summary, business, recentSos] = await Promise.all([
    buildMoney(db, societyId, p),
    buildGate(db, societyId, p),
    buildSecurity(db, societyId, p),
    buildService(db, societyId, p),
    buildWater(societyId, p),
    buildPeopleAndApp(db, societyId, p),
    buildGrowth(db, societyId),
    buildWeeklySummary(db, societyId),
    getBusinessActionCounts(db, societyId, p.from, p.now),
    db.sOSAlert.count({
      where: {
        societyId,
        status: { in: OPEN_SOS as SOSStatus[] },
        createdAt: { gte: new Date(p.now.getTime() - SOS_RECENT_DAYS * DAY_MS) },
      },
    }),
  ]);
  const { people, app, outreach } = pa;

  // ── Needs attention ────────────────────────────────────────────────
  const attention: AttentionItem[] = [];
  const add = (item: AttentionItem) => attention.push(item);

  if (recentSos > 0) {
    add({
      id: "sos_open",
      severity: "critical",
      title: `${plural(recentSos, "emergency alert")} not resolved`,
      detail: "Open the SOS screen and close each alert once it's handled.",
      area: "sos",
    });
  }
  if (money.monthsOfCover != null && money.monthsOfCover < 1) {
    add({
      id: "fund_low",
      severity: "critical",
      title: `Society fund covers less than a month of expenses`,
      detail: `Balance ${money.fundBalance}. Collect pending dues before the next big payment.`,
      area: "dues",
    });
  }
  if (money.pending.flats > 0) {
    add({
      id: "dues_pending",
      severity: money.pending.chronicFlats > 0 ? "warning" : "info",
      title: `${plural(money.pending.flats, "flat")} owe ${money.pending.amount}`,
      detail:
        money.pending.chronicFlats > 0
          ? `${plural(money.pending.chronicFlats, "flat")} owe for 2 or more months. Call them first.`
          : "Send a reminder with the Pay link.",
      area: "dues",
      list: "duesPending",
    });
  }
  if (money.onlinePayments.failed + money.onlinePayments.abandoned > 0) {
    add({
      id: "payments_failed",
      severity: "warning",
      title: `${plural(money.onlinePayments.failed + money.onlinePayments.abandoned, "online payment")} didn't go through`,
      detail: `${money.onlinePayments.failed} failed, ${money.onlinePayments.abandoned} started but not finished. Check the payment gateway and follow up.`,
      area: "dues",
    });
  }
  if (service.complaints.overdue > 0) {
    add({
      id: "complaints_overdue",
      severity: "warning",
      title: `${plural(service.complaints.overdue, "complaint")} open for over ${OVERDUE_DAYS} days`,
      detail: "Residents are waiting — assign or resolve the oldest first.",
      area: "complaints",
    });
  }
  if (gate.waitingNow > 0) {
    add({
      id: "visitors_waiting",
      severity: "warning",
      title: `${plural(gate.waitingNow, "visitor")} waiting at the gate`,
      detail: "No resident has replied yet. Guards can call the flat after 3 minutes.",
      area: "gate",
    });
  }
  if (gate.deliveries.waitingOverADay > 0) {
    add({
      id: "parcels_waiting",
      severity: "warning",
      title: `${plural(gate.deliveries.waitingOverADay, "parcel")} at the gate for over a day`,
      detail: "Remind the flats to collect them.",
      area: "gate",
    });
  }
  if (security.patrols.missed > 0) {
    add({
      id: "patrols_missed",
      severity: "warning",
      title: `${plural(security.patrols.missed, "patrol round")} missed`,
      detail: `${security.patrols.done} of ${security.patrols.planned} planned rounds done in ${p.days} days.`,
      area: "security",
    });
  }
  if (water.stale && water.daysSinceLog != null && water.daysSinceLog < days) {
    add({
      id: "water_not_logged",
      severity: "info",
      title: `Water supply not logged for ${plural(water.daysSinceLog, "day")}`,
      detail: "Residents only see water updates when guards tap ON/OFF at the gate.",
      area: "water",
    });
  } else if (water.tracked && water.longestDryMinutes != null && water.longestDryMinutes >= 24 * 60) {
    add({
      id: "water_gap",
      severity: "warning",
      title: `No water for ${water.longestDry} at a stretch`,
      detail: "Check with the supplier, or remind guards to log water ON/OFF.",
      area: "water",
    });
  }
  if (business.gateRequests >= 5 && gate.answeredInAppPct < 60) {
    add({
      id: "gate_unanswered",
      severity: "warning",
      title: `Only ${gate.answeredInAppPct}% of gate requests were answered in the app`,
      detail: "Guards had to phone residents for the rest. Ask residents to keep notifications on.",
      area: "gate",
    });
  }
  for (const c of service.contractsEnding.filter((c) => c.daysLeft <= 14)) {
    add({
      id: `contract_${c.title}`,
      severity: "warning",
      title: `${c.vendor} contract ends in ${plural(c.daysLeft, "day")}`,
      detail: `"${c.title}" — renew or find a replacement.`,
      area: "vendors",
    });
  }
  if (growth.signal.tone === "critical") {
    add({ id: "usage_drop", severity: "warning", title: growth.signal.text, detail: "See growth below.", area: "app" });
  }
  if (people.occupiedFlats > 0 && pct(people.flatsWithoutApp, people.occupiedFlats) >= 25) {
    add({
      id: "flats_without_app",
      severity: "warning",
      title: `${plural(people.flatsWithoutApp, "flat")} didn't use the app in ${days} days`,
      detail: "Visitors to these flats always need a phone call. Help them install and sign in.",
      area: "app",
      list: "flatsWithoutApp",
    });
  }
  if (outreach.cantGetAlerts.length > 0) {
    add({
      id: "no_alerts",
      severity: "info",
      title: `${plural(outreach.cantGetAlerts.length, "resident")} can't get alerts on their phone`,
      detail: "They signed out or removed the app, so gate requests and notices don't reach them.",
      area: "app",
      list: "cantGetAlerts",
    });
  }
  if (people.never > 0) {
    add({
      id: "never_used",
      severity: "info",
      title: `${plural(people.never, "account")} never opened the app`,
      detail: "Share the download link and login help with them.",
      area: "app",
      list: "neverOpened",
    });
  }
  if (people.versions.onOld > 0 && people.versions.latest) {
    add({
      id: "old_version",
      severity: "info",
      title: `${plural(people.versions.onOld, "person", "people")} on an older app version`,
      detail: `Ask them to update to ${people.versions.latest} from the Play Store / App Store.`,
      area: "app",
    });
  }
  if (gate.regularVisitors.length > 0) {
    add({
      id: "regular_visitors",
      severity: "info",
      title: `${plural(gate.regularVisitors.length, "regular visitor")} could get a standing pass`,
      detail: "They visit the same flat often. A pre-approved pass saves a call every time.",
      area: "gate",
      list: "regularVisitors",
    });
  }
  if (app.health.problemFreePct < 70 && app.health.sessions >= 10) {
    const network = app.health.connectionProblems >= app.health.appErrors;
    add({
      id: "app_errors",
      severity: "info",
      title: `${100 - app.health.problemFreePct}% of app visits hit a problem`,
      detail: network ? "Mostly slow or dropped connections, not app bugs." : "See App health below.",
      area: "app",
    });
  }
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  attention.sort((a, b) => rank[a.severity] - rank[b.severity]);

  // ── Headline cards (kept for the previous app version) ────────────
  const areas: AreaCard[] = [
    {
      id: "gate",
      title: "Gate & visitors",
      value: String(gate.letIn),
      label: gate.letIn === 1 ? "person let in" : "people let in",
      detail: `${plural(gate.requests, "gate request")} · ${gate.insideNow} inside now`,
      tone: "neutral",
      change: gate.letInChange,
    },
    {
      id: "complaints",
      title: "Complaints",
      value: String(service.complaints.open),
      label: service.complaints.open === 1 ? "complaint open" : "complaints open",
      detail: `${service.complaints.filed} filed · ${service.complaints.resolved} resolved in ${days} days`,
      tone: service.complaints.overdue > 0 ? "critical" : service.complaints.open > 0 ? "watch" : "good",
      change: null,
    },
    {
      id: "dues",
      title: "Maintenance",
      value: money.received.amount,
      label: "received",
      detail:
        money.received.payments > 0
          ? `${plural(money.received.flats, "flat")} paid · ${money.received.onlinePct}% online`
          : `No payments in ${days} days`,
      tone: "neutral",
      change: money.received.change,
    },
    {
      id: "water",
      title: "Water supply",
      value: water.perDay ?? "—",
      label: water.tracked ? "supply per day" : "not tracked yet",
      detail: water.detail,
      tone: water.tone,
      change: null,
    },
    {
      id: "app",
      title: "App usage",
      value: `${people.using} of ${people.total}`,
      label: "people used the app",
      detail: people.never > 0 ? `${plural(people.never, "account")} never opened it` : "Everyone has opened the app",
      tone: toneFor(people.usingPct, 60, 35),
      change: null,
    },
  ];

  // ── Features residents use ─────────────────────────────────────────
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
    ...(gate.gateRequests > 0
      ? [
          {
            id: "answer_in_app",
            label: "Answer gate requests in the app",
            used: gate.answeredInApp,
            of: gate.gateRequests,
            unit: "requests" as const,
            pct: gate.answeredInAppPct,
            tone: toneFor(gate.answeredInAppPct, 75, 50),
            tip: "Each unanswered request means the guard phones the resident.",
          },
        ]
      : []),
    {
      id: "pay_online",
      label: "Pay maintenance online",
      used: money.received.onlineFlats,
      of: flats,
      unit: "flats",
      pct: pct(money.received.onlineFlats, flats),
      tone: toneFor(pct(money.received.onlineFlats, flats), 40, 15),
      tip: "Add the Pay link to the next dues reminder to cut cash collection.",
    },
  ];

  return {
    period: { days, startDate: p.from.toISOString(), endDate: p.now.toISOString() },
    generatedAt: p.now.toISOString(),
    summary,
    attention,
    areas,
    money,
    gate,
    security,
    service,
    water,
    people,
    app,
    growth,
    features,
    outreach: {
      duesPending: money.pending.top,
      neverOpened: outreach.neverOpened,
      cantGetAlerts: outreach.cantGetAlerts,
      flatsWithoutApp: outreach.flatsWithoutApp,
      regularVisitors: gate.regularVisitors,
    },
    dailyActive: app.daily.map((d) => ({ date: d.date, label: d.label, count: d.active })),
  };
}
