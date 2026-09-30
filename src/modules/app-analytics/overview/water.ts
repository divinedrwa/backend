import { loadSupply, minutesOf } from "../../water-supply-analytics/loadSupply";
import { longestGapMinutes } from "../../water-supply-analytics/supplyIntervals";
import { isWaterTurnedOn } from "../../water-supply-analytics/waterEventAction";
import { type Period, type Tone, DAY_MS, formatDuration, plural } from "./common";

export type WaterSection = {
  tracked: boolean;
  /** Guards stopped logging ON/OFF more than 3 days ago. */
  stale: boolean;
  daysSinceLog: number | null;
  runningNow: number;
  perDay: string | null;
  longestDry: string | null;
  longestDryMinutes: number | null;
  tone: Tone;
  detail: string;
};

export async function buildWater(societyId: string, p: Period): Promise<WaterSection> {
  const supply = await loadSupply(societyId, p.days);
  const intervals = supply.perGate.flatMap((g) => g.intervals);
  const perDay = supply.tracked ? minutesOf(intervals) / supply.trackedDays : null;
  // Once guards stop logging, the time since is unknown — not a dry spell.
  const trackedTo = supply.stale && supply.lastLoggedAt ? supply.lastLoggedAt : p.now;
  const dry = intervals.length ? longestGapMinutes(intervals, supply.trackedFrom, trackedTo) : null;
  const daysSinceLog = supply.lastLoggedAt
    ? Math.floor((p.now.getTime() - supply.lastLoggedAt.getTime()) / DAY_MS)
    : null;
  const runningNow = supply.perGate.filter((g) => g.last && isWaterTurnedOn(g.last)).length;

  const tone: Tone = !supply.tracked
    ? "neutral"
    : supply.stale
      ? "watch"
      : dry == null || dry >= 48 * 60
        ? "critical"
        : dry >= 24 * 60
          ? "watch"
          : "good";
  const detail = !supply.tracked
    ? `Guards haven't logged water ON/OFF in ${p.days} days.`
    : supply.stale
      ? `Not logged for ${plural(daysSinceLog ?? 0, "day")} — ask guards to tap ON/OFF`
      : runningNow > 0
        ? "Water is running now"
        : dry != null
          ? `Longest without water: ${formatDuration(dry)}`
          : "No supply logged in this period";

  return {
    tracked: supply.tracked,
    stale: supply.stale,
    daysSinceLog,
    runningNow,
    perDay: perDay == null ? null : formatDuration(perDay),
    longestDry: dry == null ? null : formatDuration(dry),
    longestDryMinutes: dry,
    tone,
    detail,
  };
}
