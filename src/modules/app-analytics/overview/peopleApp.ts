import { AppAnalyticsEventKind, UserRole } from "@prisma/client";
import { compareSemver } from "../../../lib/semver";
import { RESIDENT_LIKE_ROLES } from "../../../lib/residentLike";
import { localDateKey, startOfLocalDayDaysAgo } from "../../../lib/societyTime";
import {
  getAppAnalyticsErrors,
  getAppAnalyticsInsights,
  getAppAnalyticsRoleAdoption,
} from "../appAnalytics.service";
import { PASSWORD_SIGN_IN_EVENT, SIGN_IN_TRACKING_SINCE } from "../schemas";
import {
  type Change,
  type Contact,
  type Db,
  type Period,
  WEEKDAYS,
  countChange,
  flatLabel,
  pct,
  shortDay,
  toneFor,
  type Tone,
} from "./common";


export type PeopleSection = {
  total: number;
  using: number;
  stopped: number;
  never: number;
  usingPct: number;
  roles: { role: string; label: string; total: number; using: number; stopped: number; never: number; usingPct: number }[];
  occupiedFlats: number;
  /** Occupied flats where nobody used the app in the period — guards must phone them. */
  flatsWithoutApp: number;
  /** Residents/admins with no phone that can receive alerts (never installed, signed out, or uninstalled). */
  cantGetAlerts: number;
  newResidents: { added: number; signedIn: number };
  versions: { latest: string | null; onOld: number; spread: { version: string; people: number }[] };
};

export type AppSection = {
  liveNow: number;
  activeToday: number;
  activeWeek: number;
  activeMonth: number;
  installs: number;
  installsChange: Change;
  uninstalls: number;
  /** Real password sign-ins and uninstalls are counted from this date. */
  trackingSince: string;
  signIns: number;
  signOuts: number;
  /** Times the app was opened (sessions). */
  appOpens: number;
  devices: {
    active: number;
    people: number;
    onePhone: number;
    twoPhones: number;
    threePlus: number;
    byPlatform: { label: string; count: number; pct: number }[];
    topModels: { label: string; count: number }[];
  };
  health: {
    sessions: number;
    problemFreePct: number;
    tone: Tone;
    connectionProblems: number;
    appErrors: number;
    topProblems: { label: string; count: number; people: number }[];
  };
  busiestHour: string | null;
  busiestDay: string | null;
  cameBack: { nextDay: number; week: number; month: number };
  daily: { date: string; label: string; active: number; signIns: number; installs: number }[];
};

export type Outreach = {
  neverOpened: Contact[];
  cantGetAlerts: Contact[];
  flatsWithoutApp: Contact[];
};

const PLATFORM_LABELS: Record<string, string> = { ANDROID: "Android", IOS: "iPhone", WEB: "Web" };

/** Occupied flats, the people in them, and who has a phone that can get alerts. */
async function loadResidents(db: Db, societyId: string) {
  return db.user.findMany({
    where: { societyId, isActive: true, villaId: { not: null }, role: { in: RESIDENT_LIKE_ROLES } },
    select: {
      id: true,
      name: true,
      phone: true,
      role: true,
      createdAt: true,
      villaId: true,
      villa: { select: { villaNumber: true, block: true } },
      pushDevices: { where: { isActive: true }, select: { id: true } },
    },
  });
}

export async function buildPeopleAndApp(db: Db, societyId: string, p: Period) {
  const liveCutoff = new Date(p.now.getTime() - 5 * 60 * 1000);
  const [
    adoption,
    residents,
    insights,
    errors,
    liveRows,
    firstSeen,
    uninstalls,
    authEvents,
    devices,
    versionRows,
    dailySessions,
  ] = await Promise.all([
    // These helpers count "N days ago" from the start of that day, so pass N-1.
    getAppAnalyticsRoleAdoption(db, societyId, p.days - 1, 0),
    loadResidents(db, societyId),
    getAppAnalyticsInsights(db, societyId, p.days - 1),
    getAppAnalyticsErrors(db, societyId, p.days - 1),
    db.appAnalyticsSession.findMany({
      where: { societyId, lastSeenAt: { gte: liveCutoff } },
      select: { userId: true },
      distinct: ["userId"],
    }),
    // First time each phone opened the app = an install (or a reinstall on a new phone).
    db.appAnalyticsSession.groupBy({
      by: ["deviceId"],
      where: { societyId, deviceId: { not: null } },
      _min: { startedAt: true },
    }),
    db.pushDevice.count({
      where: {
        user: { societyId },
        deactivatedReason: "UNINSTALLED",
        deactivatedAt: { gte: p.from },
      },
    }),
    db.appAnalyticsEvent.findMany({
      where: {
        societyId,
        kind: { in: [AppAnalyticsEventKind.LOGIN, AppAnalyticsEventKind.LOGOUT] },
        occurredAt: { gte: p.from },
      },
      select: { kind: true, name: true, occurredAt: true },
    }),
    db.pushDevice.findMany({
      where: { isActive: true, user: { societyId, isActive: true } },
      select: { userId: true, platform: true, deviceName: true },
    }),
    // Each person's newest app version in the last 30 days.
    db.appAnalyticsSession.findMany({
      where: { societyId, startedAt: { gte: startOfLocalDayDaysAgo(29) }, appVersion: { not: null } },
      select: { userId: true, appVersion: true, startedAt: true },
      orderBy: { startedAt: "desc" },
    }),
    db.appAnalyticsSession.findMany({
      where: { societyId, startedAt: { gte: startOfLocalDayDaysAgo(Math.min(p.days, 14) - 1) } },
      select: { userId: true, startedAt: true },
    }),
  ]);

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
  const totals = {
    total: roles.reduce((s, r) => s + r.total, 0),
    using: roles.reduce((s, r) => s + r.using, 0),
    stopped: roles.reduce((s, r) => s + r.stopped, 0),
    never: roles.reduce((s, r) => s + r.never, 0),
  };

  const activeIds = new Set(adoption.roles.flatMap((r) => r.usingAppUsers.map((u) => u.userId)));
  const neverIds = new Set(adoption.roles.flatMap((r) => r.notUsingAppUsers.neverUsed.map((u) => u.userId)));

  const flats = new Map<string, typeof residents>();
  for (const r of residents) {
    const list = flats.get(r.villaId!) ?? [];
    list.push(r);
    flats.set(r.villaId!, list);
  }
  const flatsWithoutApp = [...flats.values()].filter((people) => !people.some((u) => activeIds.has(u.id)));
  // Used the app before but no phone gets alerts now (never-opened accounts are a separate list).
  const noAlerts = residents.filter((r) => r.pushDevices.length === 0 && !neverIds.has(r.id));
  const newResidents = residents.filter((r) => r.createdAt >= p.from);

  // App versions: latest seen, and people still on something older.
  const newestByUser = new Map<string, string>();
  for (const row of versionRows) {
    if (!newestByUser.has(row.userId) && row.appVersion) newestByUser.set(row.userId, row.appVersion);
  }
  const versionsSeen = [...new Set(newestByUser.values())].sort((a, b) => compareSemver(b, a));
  const latest = versionsSeen[0] ?? null;
  const spreadMap = new Map<string, number>();
  for (const v of newestByUser.values()) spreadMap.set(v, (spreadMap.get(v) ?? 0) + 1);

  const people: PeopleSection = {
    ...totals,
    usingPct: pct(totals.using, totals.total),
    roles,
    occupiedFlats: flats.size,
    flatsWithoutApp: flatsWithoutApp.length,
    cantGetAlerts: noAlerts.length,
    newResidents: { added: newResidents.length, signedIn: newResidents.filter((r) => !neverIds.has(r.id)).length },
    versions: {
      latest,
      onOld: latest ? [...newestByUser.values()].filter((v) => compareSemver(v, latest) < 0).length : 0,
      spread: versionsSeen.slice(0, 5).map((version) => ({ version, people: spreadMap.get(version) ?? 0 })),
    },
  };

  // ── App & devices ──────────────────────────────────────────────────
  const installTimes = firstSeen.map((r) => r._min.startedAt).filter((d): d is Date => d != null);
  const installs = installTimes.filter((d) => d >= p.from).length;
  const prevInstalls = installTimes.filter((d) => d >= p.prevFrom && d < p.from).length;

  const perUser = new Map<string, number>();
  for (const d of devices) perUser.set(d.userId, (perUser.get(d.userId) ?? 0) + 1);
  const platformCounts = new Map<string, number>();
  const modelCounts = new Map<string, number>();
  for (const d of devices) {
    const label = PLATFORM_LABELS[d.platform] ?? d.platform;
    platformCounts.set(label, (platformCounts.get(label) ?? 0) + 1);
    const model = d.deviceName?.trim();
    // Skip developer emulators ("Google sdk_gphone64_arm64", "Android SDK built for x86").
    const emulator = !model || /sdk_gphone|sdk built for|emulator/i.test(model);
    if (model && model !== "Unknown Device" && !emulator) {
      modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);
    }
  }

  const et = errors.totals;
  const problemFree = et.errorFreeSessionPct ?? 100;

  // Daily series: people active, sign-ins and installs per local day.
  const dayKeys: string[] = [];
  for (let i = Math.min(p.days, 14) - 1; i >= 0; i--) dayKeys.push(localDateKey(startOfLocalDayDaysAgo(i)));
  const activeByDay = new Map<string, Set<string>>();
  for (const s of dailySessions) {
    const k = localDateKey(s.startedAt);
    const set = activeByDay.get(k) ?? new Set<string>();
    set.add(s.userId);
    activeByDay.set(k, set);
  }
  const countByDay = (dates: Date[]) => {
    const m = new Map<string, number>();
    for (const d of dates) m.set(localDateKey(d), (m.get(localDateKey(d)) ?? 0) + 1);
    return m;
  };
  const realSignIns = authEvents.filter(
    (e) => e.kind === AppAnalyticsEventKind.LOGIN && e.name === PASSWORD_SIGN_IN_EVENT,
  );
  const signInDays = countByDay(realSignIns.map((e) => e.occurredAt));
  const installDays = countByDay(installTimes);

  const peak = insights.peakHours[0];
  const topWeekday = [...insights.weekdayUsage].sort((a, b) => b.count - a.count)[0];

  const app: AppSection = {
    liveNow: liveRows.length,
    activeToday: insights.stickiness.dailyActiveUsers ?? 0,
    activeWeek: insights.stickiness.weeklyActiveUsers ?? 0,
    activeMonth: insights.stickiness.monthlyActiveUsers ?? 0,
    installs,
    installsChange: countChange(installs, prevInstalls),
    uninstalls,
    trackingSince: SIGN_IN_TRACKING_SINCE,
    signIns: realSignIns.length,
    signOuts: authEvents.filter((e) => e.kind === AppAnalyticsEventKind.LOGOUT).length,
    appOpens: et.sessions ?? 0,
    devices: {
      active: devices.length,
      people: perUser.size,
      onePhone: [...perUser.values()].filter((n) => n === 1).length,
      twoPhones: [...perUser.values()].filter((n) => n === 2).length,
      threePlus: [...perUser.values()].filter((n) => n >= 3).length,
      byPlatform: [...platformCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({ label, count, pct: pct(count, devices.length) })),
      topModels: [...modelCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([label, count]) => ({ label, count })),
    },
    health: {
      sessions: et.sessions ?? 0,
      problemFreePct: problemFree,
      tone: toneFor(problemFree, 90, 75),
      connectionProblems: et.networkErrors ?? 0,
      appErrors: et.appErrors ?? 0,
      topProblems: errors.errors.slice(0, 5).map((e) => ({ label: e.label, count: e.count, people: e.uniqueUsers })),
    },
    busiestHour: peak && peak.count > 0 ? peak.label : null,
    busiestDay: topWeekday && topWeekday.count > 0 ? WEEKDAYS[topWeekday.day]! : null,
    cameBack: {
      nextDay: insights.retention.d1Pct ?? 0,
      week: insights.retention.d7Pct ?? 0,
      month: insights.retention.d30Pct ?? 0,
    },
    daily: dayKeys.map((k) => ({
      date: k,
      label: shortDay(k),
      active: activeByDay.get(k)?.size ?? 0,
      signIns: signInDays.get(k) ?? 0,
      installs: installDays.get(k) ?? 0,
    })),
  };

  // ── Outreach lists (who to contact) ────────────────────────────────
  const residentById = new Map(residents.map((r) => [r.id, r]));
  const neverOpened: Contact[] = adoption.roles
    .filter((r) => r.role !== UserRole.GUARD)
    .flatMap((r) => r.notUsingAppUsers.neverUsed)
    .map((u) => {
      const res = residentById.get(u.userId);
      return {
        name: u.name,
        flat: res ? flatLabel(res.villa) : (u.villaNumber ?? "—"),
        phone: u.phone ?? null,
        detail: "Never opened the app",
      };
    });

  const outreach: Outreach = {
    neverOpened,
    cantGetAlerts: noAlerts.map((r) => ({ name: r.name, flat: flatLabel(r.villa), phone: r.phone, detail: "No phone set up for alerts" })),
    flatsWithoutApp: flatsWithoutApp.map((list) => {
      const first = list[0]!;
      return {
        name: list.map((u) => u.name).join(", "),
        flat: flatLabel(first.villa),
        phone: list.find((u) => u.phone)?.phone ?? null,
        detail: `No one used the app in ${p.days} days`,
      };
    }),
  };

  return { people, app, outreach };
}
