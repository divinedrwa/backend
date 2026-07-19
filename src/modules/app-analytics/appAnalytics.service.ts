import {
  AppAnalyticsEventKind,
  AppAnalyticsPlatform,
  Prisma,
  UserRole,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { startOfLocalDayDaysAgo } from "../../lib/societyTime";
import type { AnalyticsEventInput, StartSessionInput } from "./schemas";
import {
  type AnalyticsUserSnapshot,
  loadAnalyticsUserSnapshot,
  mergeUserIntoProperties,
} from "./userSnapshot";
import { BUSINESS_ACTION_LABELS } from "./analyticsCatalog";

type Db = typeof prisma | Prisma.TransactionClient;

const APP_USER_ROLES: UserRole[] = [
  UserRole.RESIDENT,
  UserRole.GUARD,
  UserRole.ADMIN,
  UserRole.RESIDENT_CUM_ADMIN,
];

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function avgDurationMs(
  sessions: { startedAt: Date; endedAt: Date | null; lastSeenAt: Date }[],
): number {
  if (sessions.length === 0) return 0;
  let total = 0;
  let count = 0;
  for (const s of sessions) {
    const end = s.endedAt ?? s.lastSeenAt;
    const ms = end.getTime() - s.startedAt.getTime();
    if (ms > 0 && ms < 86_400_000) {
      total += ms;
      count += 1;
    }
  }
  return count > 0 ? Math.round(total / count) : 0;
}

type UsageSignals = {
  activeInPeriod: Set<string>;
  everUsed: Set<string>;
  lastSeenAt: Map<string, Date>;
};

/** Union analytics + push device + refresh-token login signals for accurate engagement. */
async function loadAppUsageSignals(
  db: Db,
  societyId: string,
  since: Date,
): Promise<UsageSignals> {
  const [
    sessionsInPeriod,
    eventsInPeriod,
    everSessionUserIds,
    everEventUserIds,
    pushDevices,
    refreshTokens,
  ] = await Promise.all([
    db.appAnalyticsSession.findMany({
      where: { societyId, lastSeenAt: { gte: since } },
      select: { userId: true, lastSeenAt: true },
    }),
    db.appAnalyticsEvent.findMany({
      where: { societyId, occurredAt: { gte: since } },
      select: { userId: true, occurredAt: true },
    }),
    db.appAnalyticsSession.findMany({
      where: { societyId },
      select: { userId: true },
      distinct: ["userId"],
    }),
    db.appAnalyticsEvent.findMany({
      where: { societyId },
      select: { userId: true },
      distinct: ["userId"],
    }),
    db.pushDevice.findMany({
      where: { user: { societyId, role: { in: APP_USER_ROLES } } },
      select: { userId: true, lastUsedAt: true },
    }),
    db.refreshToken.findMany({
      where: {
        revoked: false,
        user: { societyId, role: { in: APP_USER_ROLES } },
      },
      select: { userId: true, createdAt: true },
    }),
  ]);

  const activeInPeriod = new Set<string>();
  const everUsed = new Set<string>();
  const lastSeenAt = new Map<string, Date>();

  const note = (userId: string, at: Date, inPeriod: boolean) => {
    everUsed.add(userId);
    if (inPeriod) activeInPeriod.add(userId);
    const prev = lastSeenAt.get(userId);
    if (!prev || at > prev) lastSeenAt.set(userId, at);
  };

  for (const s of sessionsInPeriod) note(s.userId, s.lastSeenAt, true);
  for (const e of eventsInPeriod) note(e.userId, e.occurredAt, true);
  for (const row of everSessionUserIds) everUsed.add(row.userId);
  for (const row of everEventUserIds) everUsed.add(row.userId);
  for (const p of pushDevices) note(p.userId, p.lastUsedAt, p.lastUsedAt >= since);
  for (const r of refreshTokens) note(r.userId, r.createdAt, r.createdAt >= since);

  return { activeInPeriod, everUsed, lastSeenAt };
}

function mergeActiveUsersIntoSets(
  userIds: Iterable<string>,
  atByUser: Map<string, Date>,
  targets: {
    period: Set<string>;
    today: Set<string>;
    week: Set<string>;
    month: Set<string>;
  },
  bounds: { since: Date; todayStart: Date; weekStart: Date; monthStart: Date },
) {
  for (const userId of userIds) {
    const at = atByUser.get(userId);
    if (!at) continue;
    if (at >= bounds.since) targets.period.add(userId);
    if (at >= bounds.todayStart) targets.today.add(userId);
    if (at >= bounds.weekStart) targets.week.add(userId);
    if (at >= bounds.monthStart) targets.month.add(userId);
  }
}

export async function createAnalyticsSession(
  db: Db,
  params: {
    societyId: string;
    userId: string;
    role: UserRole;
    body: StartSessionInput;
    userSnapshot?: AnalyticsUserSnapshot;
  },
) {
  const snapshot =
    params.userSnapshot ??
    (await loadAnalyticsUserSnapshot(db, params.societyId, params.userId));

  return db.appAnalyticsSession.create({
    data: {
      societyId: params.societyId,
      userId: params.userId,
      role: params.role,
      userName: snapshot.userName,
      username: snapshot.username,
      villaNumber: snapshot.villaNumber,
      userIsActive: snapshot.userIsActive,
      platform: params.body.platform,
      appVersion: params.body.appVersion,
      buildNumber: params.body.buildNumber,
      deviceId: params.body.deviceId,
      deviceModel: params.body.deviceModel,
      osVersion: params.body.osVersion,
    },
    select: { id: true, startedAt: true },
  });
}

export async function touchAnalyticsSession(
  db: Db,
  params: { societyId: string; sessionId: string; ended?: boolean },
) {
  const now = new Date();
  const session = await db.appAnalyticsSession.findFirst({
    where: { id: params.sessionId, societyId: params.societyId },
    select: { id: true },
  });
  if (!session) return null;
  return db.appAnalyticsSession.update({
    where: { id: params.sessionId },
    data: {
      lastSeenAt: now,
      ...(params.ended ? { endedAt: now } : {}),
    },
    select: { id: true, lastSeenAt: true, endedAt: true },
  });
}

export async function recordAnalyticsEvent(
  db: Db,
  params: {
    societyId: string;
    userId: string;
    role: UserRole;
    defaultPlatform: AppAnalyticsPlatform;
    defaultAppVersion?: string;
    event: AnalyticsEventInput;
    userSnapshot?: AnalyticsUserSnapshot;
  },
) {
  const occurredAt = params.event.occurredAt ? new Date(params.event.occurredAt) : new Date();
  const snapshot =
    params.userSnapshot ??
    (await loadAnalyticsUserSnapshot(db, params.societyId, params.userId));
  const properties = mergeUserIntoProperties(
    snapshot,
    params.userId,
    params.role,
    params.event.properties as Record<string, unknown> | undefined,
  );

  try {
    return await db.appAnalyticsEvent.create({
      data: {
        societyId: params.societyId,
        userId: params.userId,
        role: params.role,
        userName: snapshot.userName,
        username: snapshot.username,
        villaNumber: snapshot.villaNumber,
        userIsActive: snapshot.userIsActive,
        platform: params.event.platform ?? params.defaultPlatform,
        appVersion: params.event.appVersion ?? params.defaultAppVersion,
        sessionId: params.event.sessionId,
        kind: params.event.kind,
        name: params.event.name,
        durationMs: params.event.durationMs,
        success: params.event.success,
        properties,
        clientEventId: params.event.clientEventId,
        occurredAt,
      },
      select: { id: true, occurredAt: true },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { id: "duplicate", occurredAt, duplicate: true as const };
    }
    throw e;
  }
}

export async function recordAnalyticsEventBatch(
  db: Db,
  params: {
    societyId: string;
    userId: string;
    role: UserRole;
    defaultPlatform: AppAnalyticsPlatform;
    defaultAppVersion?: string;
    events: AnalyticsEventInput[];
    userSnapshot?: AnalyticsUserSnapshot;
  },
) {
  const snapshot =
    params.userSnapshot ??
    (await loadAnalyticsUserSnapshot(db, params.societyId, params.userId));

  let accepted = 0;
  let duplicates = 0;
  for (const event of params.events) {
    const row = await recordAnalyticsEvent(db, { ...params, event, userSnapshot: snapshot });
    if ("duplicate" in row && row.duplicate) duplicates += 1;
    else accepted += 1;
  }
  return { accepted, duplicates, total: params.events.length };
}

export async function getAppAnalyticsSummary(db: Db, societyId: string, days: number) {
  const since = startOfLocalDayDaysAgo(days);
  const todayStart = startOfLocalDayDaysAgo(0);
  const weekStart = startOfLocalDayDaysAgo(7);
  const monthStart = startOfLocalDayDaysAgo(30);

  const [sessions, events, pushDevices, usersByRole, usageSignals] = await Promise.all([
    db.appAnalyticsSession.findMany({
      where: { societyId, startedAt: { gte: since } },
      select: {
        id: true,
        userId: true,
        role: true,
        platform: true,
        appVersion: true,
        deviceId: true,
        startedAt: true,
        endedAt: true,
        lastSeenAt: true,
        user: { select: { name: true, username: true } },
      },
    }),
    db.appAnalyticsEvent.findMany({
      where: { societyId, occurredAt: { gte: since } },
      select: {
        userId: true,
        role: true,
        platform: true,
        kind: true,
        name: true,
        occurredAt: true,
        durationMs: true,
        success: true,
      },
    }),
    db.pushDevice.findMany({
      where: { user: { societyId }, isActive: true },
      select: {
        platform: true,
        deviceType: true,
        lastUsedAt: true,
        userId: true,
      },
    }),
    db.user.groupBy({
      by: ["role"],
      where: { societyId, isActive: true },
      _count: true,
    }),
    loadAppUsageSignals(db, societyId, since),
  ]);

  const activeUserIdsPeriod = new Set<string>();
  const activeUserIdsToday = new Set<string>();
  const activeUserIdsWeek = new Set<string>();
  const bounds = { since, todayStart, weekStart, monthStart };
  const activeTargets = {
    period: activeUserIdsPeriod,
    today: activeUserIdsToday,
    week: activeUserIdsWeek,
    month: new Set<string>(),
  };

  for (const s of sessions) {
    activeTargets.period.add(s.userId);
    if (s.lastSeenAt >= todayStart) activeTargets.today.add(s.userId);
    if (s.lastSeenAt >= weekStart) activeTargets.week.add(s.userId);
    if (s.lastSeenAt >= monthStart) activeTargets.month.add(s.userId);
  }
  for (const e of events) {
    activeTargets.period.add(e.userId);
    if (e.occurredAt >= todayStart) activeTargets.today.add(e.userId);
    if (e.occurredAt >= weekStart) activeTargets.week.add(e.userId);
    if (e.occurredAt >= monthStart) activeTargets.month.add(e.userId);
  }
  mergeActiveUsersIntoSets(
    usageSignals.everUsed,
    usageSignals.lastSeenAt,
    activeTargets,
    bounds,
  );

  const logins = events.filter((e) => e.kind === AppAnalyticsEventKind.LOGIN).length;
  const screenViews = events.filter((e) => e.kind === AppAnalyticsEventKind.SCREEN_VIEW).length;
  const flowEvents = events.filter((e) => e.kind === AppAnalyticsEventKind.FLOW_COMPLETE);
  const actionEvents = events.filter((e) => e.kind === AppAnalyticsEventKind.ACTION);
  const errors = events.filter((e) => e.kind === AppAnalyticsEventKind.ERROR).length;
  const mau = activeTargets.month.size;
  const dau = activeUserIdsToday.size;
  const stickinessPct = mau > 0 ? Math.round((dau / mau) * 100) : 0;

  const byRole: Record<string, number> = {};
  for (const s of sessions) {
    byRole[s.role] = (byRole[s.role] ?? 0) + 1;
  }

  const byPlatform: Record<string, number> = {};
  for (const s of sessions) {
    byPlatform[s.platform] = (byPlatform[s.platform] ?? 0) + 1;
  }

  const byAppVersion: Record<string, number> = {};
  for (const s of sessions) {
    const v = s.appVersion ?? "unknown";
    byAppVersion[v] = (byAppVersion[v] ?? 0) + 1;
  }

  const uniqueDevices = new Set(sessions.map((s) => s.deviceId).filter(Boolean));

  const pushActiveToday = pushDevices.filter((d) => d.lastUsedAt >= todayStart).length;
  const pushActiveWeek = pushDevices.filter((d) => d.lastUsedAt >= weekStart).length;

  const engagement = await getAppAnalyticsEngagementCounts(db, societyId, days);

  const societyUserRoles = await db.user.findMany({
    where: { societyId, role: { in: APP_USER_ROLES } },
    select: { id: true, role: true },
  });
  const roleByUserId = new Map(societyUserRoles.map((u) => [u.id, u.role]));

  const activeByRole: Record<string, number> = {};
  for (const uid of activeUserIdsPeriod) {
    const session = sessions.find((s) => s.userId === uid);
    const event = events.find((e) => e.userId === uid);
    const role = session?.role ?? event?.role ?? roleByUserId.get(uid);
    if (role) activeByRole[role] = (activeByRole[role] ?? 0) + 1;
  }

  return {
    period: { days, startDate: since.toISOString(), endDate: new Date().toISOString() },
    totals: {
      sessions: sessions.length,
      events: events.length,
      logins,
      screenViews,
      flowCompletions: flowEvents.length,
      actions: actionEvents.length,
      errors,
      uniqueActiveUsers: activeUserIdsPeriod.size,
      monthlyActiveUsers: mau,
      dailyActiveUsers: activeUserIdsToday.size,
      weeklyActiveUsers: activeUserIdsWeek.size,
      stickinessPct,
      uniqueDevices: uniqueDevices.size,
      avgSessionDurationMs: avgDurationMs(sessions),
      registeredAccounts: usersByRole.reduce((sum, r) => sum + r._count, 0),
    },
    pushDevices: {
      registered: pushDevices.length,
      activeToday: pushActiveToday,
      activeWeek: pushActiveWeek,
      byPlatform: pushDevices.reduce<Record<string, number>>((acc, d) => {
        const key = d.platform ?? d.deviceType ?? "UNKNOWN";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    },
    byRole: Object.entries(byRole).map(([role, sessionCount]) => ({ role, sessionCount })),
    byPlatform: Object.entries(byPlatform).map(([platform, sessionCount]) => ({
      platform,
      sessionCount,
    })),
    byAppVersion: Object.entries(byAppVersion)
      .map(([appVersion, sessionCount]) => ({ appVersion, sessionCount }))
      .sort((a, b) => b.sessionCount - a.sessionCount)
      .slice(0, 10),
    accountsByRole: usersByRole.map((r) => ({ role: r.role, count: r._count })),
    engagement,
    activeUsersByRole: Object.entries(activeByRole).map(([role, count]) => ({ role, count })),
  };
}

export async function getAppAnalyticsDailyTrend(db: Db, societyId: string, days: number) {
  const since = startOfLocalDayDaysAgo(days);
  const [sessions, events] = await Promise.all([
    db.appAnalyticsSession.findMany({
      where: { societyId, startedAt: { gte: since } },
      select: { userId: true, startedAt: true },
    }),
    db.appAnalyticsEvent.findMany({
      where: { societyId, occurredAt: { gte: since } },
      select: { userId: true, kind: true, occurredAt: true },
    }),
  ]);

  const trendMap = new Map<
    string,
    { date: string; sessions: number; events: number; activeUsers: Set<string>; logins: number }
  >();

  for (let i = days - 1; i >= 0; i -= 1) {
    const d = startOfLocalDayDaysAgo(i);
    const key = dayKey(d);
    trendMap.set(key, {
      date: key,
      sessions: 0,
      events: 0,
      activeUsers: new Set(),
      logins: 0,
    });
  }

  for (const s of sessions) {
    const key = dayKey(s.startedAt);
    const slot = trendMap.get(key);
    if (!slot) continue;
    slot.sessions += 1;
    slot.activeUsers.add(s.userId);
  }

  for (const e of events) {
    const key = dayKey(e.occurredAt);
    const slot = trendMap.get(key);
    if (!slot) continue;
    slot.events += 1;
    slot.activeUsers.add(e.userId);
    if (e.kind === AppAnalyticsEventKind.LOGIN) slot.logins += 1;
  }

  return {
    trendData: [...trendMap.values()].map((t) => ({
      date: t.date,
      displayDate: t.date,
      sessions: t.sessions,
      events: t.events,
      activeUsers: t.activeUsers.size,
      logins: t.logins,
    })),
  };
}

export async function getAppAnalyticsTopScreens(db: Db, societyId: string, days: number) {
  const since = startOfLocalDayDaysAgo(days);
  const rows = await db.appAnalyticsEvent.groupBy({
    by: ["name"],
    where: {
      societyId,
      kind: AppAnalyticsEventKind.SCREEN_VIEW,
      occurredAt: { gte: since },
    },
    _count: { _all: true },
  });
  return {
    screens: rows
      .map((r) => ({ screen: r.name, views: r._count._all }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 25),
  };
}

/** Human-readable labels for tracked business actions (client `ACTION` events). */
export { BUSINESS_ACTION_LABELS } from "./analyticsCatalog";

export async function getAppAnalyticsActions(
  db: Db,
  societyId: string,
  days: number,
  registeredActiveAccounts: number,
) {
  const since = startOfLocalDayDaysAgo(days);
  const events = await db.appAnalyticsEvent.findMany({
    where: {
      societyId,
      kind: AppAnalyticsEventKind.ACTION,
      occurredAt: { gte: since },
    },
    select: { name: true, userId: true, role: true, occurredAt: true },
  });

  const map = new Map<
    string,
    { action: string; label: string; count: number; uniqueUsers: Set<string>; byRole: Record<string, number> }
  >();
  for (const e of events) {
    const slot = map.get(e.name) ?? {
      action: e.name,
      label: BUSINESS_ACTION_LABELS[e.name] ?? e.name.replace(/_/g, " "),
      count: 0,
      uniqueUsers: new Set<string>(),
      byRole: {},
    };
    slot.count += 1;
    slot.uniqueUsers.add(e.userId);
    slot.byRole[e.role] = (slot.byRole[e.role] ?? 0) + 1;
    map.set(e.name, slot);
  }

  const denominator = Math.max(registeredActiveAccounts, 1);
  return {
    actions: [...map.values()]
      .map((a) => ({
        action: a.action,
        label: a.label,
        count: a.count,
        uniqueUsers: a.uniqueUsers.size,
        adoptionPct: Math.round((a.uniqueUsers.size / denominator) * 100),
        byRole: Object.entries(a.byRole).map(([role, count]) => ({ role, count })),
      }))
      .sort((a, b) => b.count - a.count),
    totals: { events: events.length, distinctActions: map.size },
  };
}

export async function getAppAnalyticsErrors(db: Db, societyId: string, days: number) {
  const since = startOfLocalDayDaysAgo(days);
  const events = await db.appAnalyticsEvent.findMany({
    where: {
      societyId,
      kind: AppAnalyticsEventKind.ERROR,
      occurredAt: { gte: since },
    },
    select: { name: true, userId: true, role: true, occurredAt: true, appVersion: true },
    orderBy: { occurredAt: "desc" },
  });

  const map = new Map<
    string,
    {
      error: string;
      count: number;
      uniqueUsers: Set<string>;
      lastOccurredAt: Date;
      byRole: Record<string, number>;
    }
  >();
  for (const e of events) {
    const slot = map.get(e.name) ?? {
      error: e.name,
      count: 0,
      uniqueUsers: new Set<string>(),
      lastOccurredAt: e.occurredAt,
      byRole: {},
    };
    slot.count += 1;
    slot.uniqueUsers.add(e.userId);
    if (e.occurredAt > slot.lastOccurredAt) slot.lastOccurredAt = e.occurredAt;
    slot.byRole[e.role] = (slot.byRole[e.role] ?? 0) + 1;
    map.set(e.name, slot);
  }

  const sessionsInPeriod = await db.appAnalyticsSession.count({
    where: { societyId, startedAt: { gte: since } },
  });

  return {
    errors: [...map.values()]
      .map((e) => ({
        error: e.error,
        count: e.count,
        uniqueUsers: e.uniqueUsers.size,
        lastOccurredAt: e.lastOccurredAt.toISOString(),
        byRole: Object.entries(e.byRole).map(([role, count]) => ({ role, count })),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25),
    totals: {
      events: events.length,
      distinctErrors: map.size,
      errorRatePct:
        sessionsInPeriod > 0 ? Math.round((events.length / sessionsInPeriod) * 100) : 0,
    },
  };
}

export async function getAppAnalyticsInsights(db: Db, societyId: string, days: number) {
  const since = startOfLocalDayDaysAgo(days);
  const todayStart = startOfLocalDayDaysAgo(0);
  const weekStart = startOfLocalDayDaysAgo(7);
  const monthStart = startOfLocalDayDaysAgo(30);

  const [sessions, events, firstSessions] = await Promise.all([
    db.appAnalyticsSession.findMany({
      where: { societyId, startedAt: { gte: since } },
      select: { userId: true, startedAt: true, lastSeenAt: true, role: true },
    }),
    db.appAnalyticsEvent.findMany({
      where: { societyId, occurredAt: { gte: since } },
      select: { userId: true, occurredAt: true, role: true },
    }),
    db.appAnalyticsSession.groupBy({
      by: ["userId"],
      where: { societyId },
      _min: { startedAt: true },
    }),
  ]);

  const firstSeen = new Map<string, Date>();
  for (const row of firstSessions) {
    if (row._min.startedAt) firstSeen.set(row.userId, row._min.startedAt);
  }

  const activeToday = new Set<string>();
  const activeWeek = new Set<string>();
  const activeMonth = new Set<string>();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, label: `${hour}:00`, count: 0 }));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, day) => ({
    day,
    label,
    count: 0,
  }));

  for (const s of sessions) {
    if (s.lastSeenAt >= todayStart) activeToday.add(s.userId);
    if (s.lastSeenAt >= weekStart) activeWeek.add(s.userId);
    if (s.lastSeenAt >= monthStart) activeMonth.add(s.userId);
    const h = s.startedAt.getHours();
    hourly[h]!.count += 1;
    weekday[s.startedAt.getDay()]!.count += 1;
  }
  for (const e of events) {
    if (e.occurredAt >= todayStart) activeToday.add(e.userId);
    if (e.occurredAt >= weekStart) activeWeek.add(e.userId);
    if (e.occurredAt >= monthStart) activeMonth.add(e.userId);
  }

  const dau = activeToday.size;
  const wau = activeWeek.size;
  const mau = activeMonth.size;

  function retentionPct(cohortBefore: Date, returnSince: Date): number {
    let eligible = 0;
    let returned = 0;
    for (const [userId, first] of firstSeen) {
      if (first > cohortBefore) continue;
      eligible += 1;
      const activeInReturn =
        sessions.some((s) => s.userId === userId && s.lastSeenAt >= returnSince) ||
        events.some((e) => e.userId === userId && e.occurredAt >= returnSince);
      if (activeInReturn) returned += 1;
    }
    return eligible > 0 ? Math.round((returned / eligible) * 100) : 0;
  }

  const peakHours = [...hourly]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((h) => ({ hour: h.hour, label: h.label, count: h.count }));

  const sessionsByRole: Record<string, number> = {};
  for (const s of sessions) {
    sessionsByRole[s.role] = (sessionsByRole[s.role] ?? 0) + 1;
  }

  return {
    period: { days, startDate: since.toISOString(), endDate: new Date().toISOString() },
    stickiness: {
      dailyActiveUsers: dau,
      weeklyActiveUsers: wau,
      monthlyActiveUsers: mau,
      stickinessPct: mau > 0 ? Math.round((dau / mau) * 100) : 0,
      wauMauPct: mau > 0 ? Math.round((wau / mau) * 100) : 0,
    },
    retention: {
      d7Pct: retentionPct(weekStart, weekStart),
      d30Pct: retentionPct(monthStart, weekStart),
    },
    peakHours,
    hourlyData: hourly,
    weekdayUsage: weekday,
    sessionsByRole: Object.entries(sessionsByRole).map(([role, count]) => ({ role, count })),
  };
}

export async function getAppAnalyticsFlows(db: Db, societyId: string, days: number) {
  const since = startOfLocalDayDaysAgo(days);
  const events = await db.appAnalyticsEvent.findMany({
    where: {
      societyId,
      kind: AppAnalyticsEventKind.FLOW_COMPLETE,
      occurredAt: { gte: since },
    },
    select: { name: true, durationMs: true, success: true },
  });

  const map = new Map<
    string,
    { flowId: string; count: number; successCount: number; totalDurationMs: number }
  >();
  for (const e of events) {
    const slot = map.get(e.name) ?? {
      flowId: e.name,
      count: 0,
      successCount: 0,
      totalDurationMs: 0,
    };
    slot.count += 1;
    if (e.success !== false) slot.successCount += 1;
    slot.totalDurationMs += e.durationMs ?? 0;
    map.set(e.name, slot);
  }

  return {
    flows: [...map.values()]
      .map((f) => ({
        flowId: f.flowId,
        count: f.count,
        successRate: f.count > 0 ? Math.round((f.successCount / f.count) * 100) : 0,
        avgDurationMs: f.count > 0 ? Math.round(f.totalDurationMs / f.count) : 0,
      }))
      .sort((a, b) => b.count - a.count),
  };
}

export async function getAppAnalyticsActiveUsers(
  db: Db,
  societyId: string,
  days: number,
  limit: number,
) {
  const since = startOfLocalDayDaysAgo(days);
  const sessions = await db.appAnalyticsSession.findMany({
    where: { societyId, lastSeenAt: { gte: since } },
    select: {
      userId: true,
      role: true,
      platform: true,
      appVersion: true,
      lastSeenAt: true,
      startedAt: true,
      user: { select: { name: true, username: true, isActive: true, villa: { select: { villaNumber: true } } } },
    },
    orderBy: { lastSeenAt: "desc" },
    take: 500,
  });

  const byUser = new Map<
    string,
    {
      userId: string;
      name: string;
      username: string;
      villaNumber: string | null;
      role: UserRole;
      isActive: boolean;
      platform: AppAnalyticsPlatform;
      appVersion: string | null;
      lastSeenAt: Date;
      sessionCount: number;
    }
  >();

  for (const s of sessions) {
    const existing = byUser.get(s.userId);
    if (!existing || s.lastSeenAt > existing.lastSeenAt) {
      byUser.set(s.userId, {
        userId: s.userId,
        name: s.user.name,
        username: s.user.username,
        villaNumber: s.user.villa?.villaNumber ?? null,
        role: s.role,
        isActive: s.user.isActive,
        platform: s.platform,
        appVersion: s.appVersion,
        lastSeenAt: s.lastSeenAt,
        sessionCount: (existing?.sessionCount ?? 0) + 1,
      });
    } else if (existing) {
      existing.sessionCount += 1;
    }
  }

  const users = [...byUser.values()]
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
    .slice(0, limit)
    .map((u) => ({
      ...u,
      lastSeenAt: u.lastSeenAt.toISOString(),
    }));

  return { users, total: byUser.size };
}

type EngagementUserRow = {
  userId: string;
  name: string;
  username: string;
  villaNumber: string | null;
  role: UserRole;
  isActive: boolean;
  status: "active" | "inactive" | "never_used" | "deactivated";
};

async function getAppAnalyticsEngagementCounts(db: Db, societyId: string, days: number) {
  const since = startOfLocalDayDaysAgo(days);

  const [allUsers, usageSignals] = await Promise.all([
    db.user.findMany({
      where: { societyId, role: { in: APP_USER_ROLES } },
      select: { id: true, isActive: true, role: true },
    }),
    loadAppUsageSignals(db, societyId, since),
  ]);

  const { activeInPeriod, everUsed } = usageSignals;

  let registeredActive = 0;
  let activeCount = 0;
  let inactiveCount = 0;
  let neverUsedCount = 0;
  let deactivatedCount = 0;
  const byRole: Record<string, { active: number; inactive: number; neverUsed: number }> = {};

  for (const u of allUsers) {
    if (!byRole[u.role]) {
      byRole[u.role] = { active: 0, inactive: 0, neverUsed: 0 };
    }
    if (!u.isActive) {
      deactivatedCount += 1;
      continue;
    }
    registeredActive += 1;
    if (activeInPeriod.has(u.id)) {
      activeCount += 1;
      byRole[u.role].active += 1;
    } else if (everUsed.has(u.id)) {
      inactiveCount += 1;
      byRole[u.role].inactive += 1;
    } else {
      neverUsedCount += 1;
      byRole[u.role].neverUsed += 1;
    }
  }

  return {
    registeredActiveAccounts: registeredActive,
    activeInPeriod: activeCount,
    inactiveInPeriod: inactiveCount,
    neverUsedApp: neverUsedCount,
    deactivatedAccounts: deactivatedCount,
    byRole: Object.entries(byRole).map(([role, counts]) => ({ role, ...counts })),
  };
}

export async function getAppAnalyticsUserEngagement(
  db: Db,
  societyId: string,
  days: number,
  limit: number,
) {
  const since = startOfLocalDayDaysAgo(days);

  const [allUsers, usageSignals] = await Promise.all([
    db.user.findMany({
      where: { societyId, role: { in: APP_USER_ROLES } },
      select: {
        id: true,
        name: true,
        username: true,
        role: true,
        isActive: true,
        villa: { select: { villaNumber: true } },
      },
      orderBy: [{ role: "asc" }, { name: "asc" }],
    }),
    loadAppUsageSignals(db, societyId, since),
  ]);

  const { activeInPeriod, everUsed, lastSeenAt: lastSeenMap } = usageSignals;

  const activeUsers: EngagementUserRow[] = [];
  const inactiveUsers: EngagementUserRow[] = [];
  const neverUsedUsers: EngagementUserRow[] = [];
  const deactivatedUsers: EngagementUserRow[] = [];

  for (const u of allUsers) {
    const base = {
      userId: u.id,
      name: u.name,
      username: u.username,
      villaNumber: u.villa?.villaNumber ?? null,
      role: u.role,
      isActive: u.isActive,
    };
    if (!u.isActive) {
      deactivatedUsers.push({ ...base, status: "deactivated" });
      continue;
    }
    if (activeInPeriod.has(u.id)) {
      activeUsers.push({ ...base, status: "active" });
    } else if (everUsed.has(u.id)) {
      inactiveUsers.push({ ...base, status: "inactive" });
    } else {
      neverUsedUsers.push({ ...base, status: "never_used" });
    }
  }

  const sortByLastSeen = (a: EngagementUserRow, b: EngagementUserRow) => {
    const ta = lastSeenMap.get(a.userId)?.getTime() ?? 0;
    const tb = lastSeenMap.get(b.userId)?.getTime() ?? 0;
    return tb - ta;
  };

  activeUsers.sort(sortByLastSeen);
  inactiveUsers.sort(sortByLastSeen);

  let registeredActive = 0;
  let activeCount = 0;
  let inactiveCount = 0;
  let neverUsedCount = 0;
  let deactivatedCount = 0;
  const byRole: Record<string, { active: number; inactive: number; neverUsed: number }> = {};

  for (const u of allUsers) {
    if (!byRole[u.role]) {
      byRole[u.role] = { active: 0, inactive: 0, neverUsed: 0 };
    }
    if (!u.isActive) {
      deactivatedCount += 1;
      continue;
    }
    registeredActive += 1;
    if (activeInPeriod.has(u.id)) {
      activeCount += 1;
      byRole[u.role].active += 1;
    } else if (everUsed.has(u.id)) {
      inactiveCount += 1;
      byRole[u.role].inactive += 1;
    } else {
      neverUsedCount += 1;
      byRole[u.role].neverUsed += 1;
    }
  }

  const counts = {
    registeredActiveAccounts: registeredActive,
    activeInPeriod: activeCount,
    inactiveInPeriod: inactiveCount,
    neverUsedApp: neverUsedCount,
    deactivatedAccounts: deactivatedCount,
    byRole: Object.entries(byRole).map(([role, roleCounts]) => ({ role, ...roleCounts })),
  };

  return {
    period: { days, startDate: since.toISOString(), endDate: new Date().toISOString() },
    counts,
    activeUsers: activeUsers.slice(0, limit).map((u) => ({
      ...u,
      lastSeenAt: lastSeenMap.get(u.userId)?.toISOString() ?? null,
    })),
    inactiveUsers: inactiveUsers.slice(0, limit).map((u) => ({
      ...u,
      lastSeenAt: lastSeenMap.get(u.userId)?.toISOString() ?? null,
    })),
    neverUsedUsers: neverUsedUsers.slice(0, limit),
    deactivatedUsers: deactivatedUsers.slice(0, limit),
    totals: {
      active: activeUsers.length,
      inactive: inactiveUsers.length,
      neverUsed: neverUsedUsers.length,
      deactivated: deactivatedUsers.length,
    },
  };
}
