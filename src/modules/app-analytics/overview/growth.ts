import { RESIDENT_LIKE_ROLES } from "../../../lib/residentLike";
import { localDateKey, startOfLocalDayDaysAgo } from "../../../lib/societyTime";
import { type Change, type Db, DAY_MS, countChange, pct, shortDay } from "./common";

const WEEKS = 8;

export type GrowthSection = {
  occupiedFlats: number;
  /** Flats where someone used the app, per week (oldest first). */
  weeklyActiveFlats: { label: string; flats: number; pct: number }[];
  thisWeek: number;
  lastWeek: number;
  change: Change;
  /** Plain-language reading of the trend. */
  signal: { tone: "good" | "watch" | "critical" | "neutral"; text: string };
};

/** Weekly active flats for a set of societies over the last [WEEKS] weeks. */
async function weeklyActiveFlats(db: Db, societyIds: string[]) {
  const start = startOfLocalDayDaysAgo(WEEKS * 7 - 1);
  const [sessions, residents] = await Promise.all([
    db.appAnalyticsSession.findMany({
      where: { societyId: { in: societyIds }, startedAt: { gte: start } },
      select: { societyId: true, userId: true, startedAt: true },
    }),
    db.user.findMany({
      where: {
        societyId: { in: societyIds },
        isActive: true,
        villaId: { not: null },
        role: { in: RESIDENT_LIKE_ROLES },
      },
      select: { id: true, villaId: true, societyId: true },
    }),
  ]);
  const villaOf = new Map(residents.map((r) => [r.id, r.villaId!]));
  const occupied = new Map<string, Set<string>>();
  for (const r of residents) {
    if (!r.societyId) continue;
    const set = occupied.get(r.societyId) ?? new Set<string>();
    set.add(r.villaId!);
    occupied.set(r.societyId, set);
  }

  // Week 0 is the oldest; the last bucket ends today.
  const buckets = new Map<string, Set<string>[]>();
  for (const id of societyIds) buckets.set(id, Array.from({ length: WEEKS }, () => new Set<string>()));
  for (const s of sessions) {
    const villa = villaOf.get(s.userId);
    if (!villa) continue;
    const week = Math.floor((s.startedAt.getTime() - start.getTime()) / (7 * DAY_MS));
    if (week < 0 || week >= WEEKS) continue;
    buckets.get(s.societyId)?.[week]?.add(villa);
  }
  return { start, occupied, buckets };
}

/** Society-local start date of the week, e.g. "12/9" (the server runs in UTC). */
function weekLabel(start: Date, week: number): string {
  return shortDay(localDateKey(new Date(start.getTime() + week * 7 * DAY_MS + 12 * 60 * 60 * 1000)));
}

function readSignal(thisWeek: number, lastWeek: number, occupied: number): GrowthSection["signal"] {
  const reach = pct(thisWeek, occupied);
  if (occupied === 0) return { tone: "neutral", text: "No occupied flats yet." };
  if (thisWeek === 0) return { tone: "critical", text: "No flat used the app this week." };
  if (lastWeek >= 3 && thisWeek <= lastWeek * 0.7) {
    return {
      tone: "critical",
      text: `Usage dropped: ${thisWeek} flats this week vs ${lastWeek} last week. Check for app problems or send a reminder.`,
    };
  }
  if (reach < 30) {
    return {
      tone: "watch",
      text: `Only ${reach}% of flats used the app this week. Most visitors still need a phone call.`,
    };
  }
  if (thisWeek > lastWeek) return { tone: "good", text: `Growing: ${thisWeek} flats this week, up from ${lastWeek}.` };
  return { tone: "good", text: `Steady: ${reach}% of flats use the app every week.` };
}

export async function buildGrowth(db: Db, societyId: string): Promise<GrowthSection> {
  const { start, occupied, buckets } = await weeklyActiveFlats(db, [societyId]);
  const occ = occupied.get(societyId)?.size ?? 0;
  const weeks = buckets.get(societyId)!;
  const thisWeek = weeks[WEEKS - 1]!.size;
  const lastWeek = weeks[WEEKS - 2]!.size;
  return {
    occupiedFlats: occ,
    weeklyActiveFlats: weeks.map((set, i) => ({ label: weekLabel(start, i), flats: set.size, pct: pct(set.size, occ) })),
    thisWeek,
    lastWeek,
    change: countChange(thisWeek, lastWeek),
    signal: readSignal(thisWeek, lastWeek, occ),
  };
}

/** Platform owner view: one row per live society, weakest first. */
export async function buildPlatformGrowth(db: Db) {
  const societies = await db.society.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true },
  });
  if (societies.length === 0) return { societies: [], totals: { societies: 0, occupiedFlats: 0, activeFlats: 0 } };
  const ids = societies.map((s) => s.id);
  const since30 = startOfLocalDayDaysAgo(29);
  const [{ occupied, buckets }, visitors, complaints, monthSessions, residents] = await Promise.all([
    weeklyActiveFlats(db, ids),
    db.visitor.groupBy({ by: ["societyId"], where: { societyId: { in: ids }, createdAt: { gte: since30 } }, _count: true }),
    db.complaint.groupBy({ by: ["societyId"], where: { societyId: { in: ids }, createdAt: { gte: since30 } }, _count: true }),
    db.appAnalyticsSession.findMany({
      where: { societyId: { in: ids }, startedAt: { gte: since30 } },
      select: { societyId: true, userId: true },
      distinct: ["userId"],
    }),
    db.user.findMany({
      where: { societyId: { in: ids }, isActive: true, villaId: { not: null }, role: { in: RESIDENT_LIKE_ROLES } },
      select: { id: true, villaId: true },
    }),
  ]);
  const villaOf = new Map(residents.map((r) => [r.id, r.villaId!]));
  const monthFlats = new Map<string, Set<string>>();
  for (const s of monthSessions) {
    const v = villaOf.get(s.userId);
    if (!v) continue;
    const set = monthFlats.get(s.societyId) ?? new Set<string>();
    set.add(v);
    monthFlats.set(s.societyId, set);
  }
  const count = (rows: { societyId: string; _count: number }[]) => new Map(rows.map((r) => [r.societyId, r._count]));
  const visitorsBy = count(visitors);
  const complaintsBy = count(complaints);

  const rows = societies.map((s) => {
    const occ = occupied.get(s.id)?.size ?? 0;
    const weeks = buckets.get(s.id)!;
    const thisWeek = weeks[WEEKS - 1]!.size;
    const lastWeek = weeks[WEEKS - 2]!.size;
    const active30 = monthFlats.get(s.id)?.size ?? 0;
    return {
      societyId: s.id,
      name: s.name,
      occupiedFlats: occ,
      activeFlatsMonth: active30,
      monthlyReachPct: pct(active30, occ),
      thisWeek,
      lastWeek,
      change: countChange(thisWeek, lastWeek),
      trend: weeks.map((set) => set.size),
      visitors30: visitorsBy.get(s.id) ?? 0,
      complaints30: complaintsBy.get(s.id) ?? 0,
      signal: readSignal(thisWeek, lastWeek, occ),
    };
  });
  const rank = { critical: 0, watch: 1, neutral: 2, good: 3 } as const;
  rows.sort((a, b) => rank[a.signal.tone] - rank[b.signal.tone] || a.monthlyReachPct - b.monthlyReachPct);

  return {
    societies: rows,
    totals: {
      societies: rows.length,
      occupiedFlats: rows.reduce((s, r) => s + r.occupiedFlats, 0),
      activeFlats: rows.reduce((s, r) => s + r.activeFlatsMonth, 0),
    },
  };
}
