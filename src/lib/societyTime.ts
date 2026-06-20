/**
 * Society-local calendar helpers for analytics bucketing.
 * Production runs in UTC (Render); events must be grouped in society local time.
 */
const DEFAULT_TZ = process.env.SOCIETY_TIMEZONE?.trim() || "Asia/Kolkata";

/** Fixed-offset zones used when computing local midnights for query windows. */
const FIXED_OFFSET_MS: Record<string, number> = {
  "Asia/Kolkata": 5.5 * 60 * 60 * 1000,
};

export function societyTimeZone(): string {
  return DEFAULT_TZ;
}

function fixedOffsetMs(timeZone: string): number {
  return FIXED_OFFSET_MS[timeZone] ?? 0;
}

/** YYYY-MM-DD in society local time. */
export function localDateKey(date: Date, timeZone = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Hour 0–23 in society local time. */
export function localHour(date: Date, timeZone = DEFAULT_TZ): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).format(date);
  const parsed = parseInt(hour, 10);
  return parsed === 24 ? 0 : parsed;
}

/** YYYY-MM in society local time. */
export function localMonthKey(date: Date, timeZone = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

/** Inclusive list of local date keys for the last N calendar days (oldest first). */
export function localDateKeysForLastDays(
  daysCount: number,
  timeZone = DEFAULT_TZ,
): string[] {
  const keys: string[] = [];
  const offset = fixedOffsetMs(timeZone);
  const shiftedNow = new Date(Date.now() + offset);
  const y = shiftedNow.getUTCFullYear();
  const m = shiftedNow.getUTCMonth();
  const d = shiftedNow.getUTCDate();

  for (let i = daysCount - 1; i >= 0; i--) {
    const dayStartUtc = Date.UTC(y, m, d - i, 0, 0, 0, 0) - offset;
    keys.push(localDateKey(new Date(dayStartUtc), timeZone));
  }
  return keys;
}

/** Start instant of the local calendar day that is `daysAgo` days before today (local). */
export function startOfLocalDayDaysAgo(
  daysAgo: number,
  timeZone = DEFAULT_TZ,
): Date {
  const offset = fixedOffsetMs(timeZone);
  const shiftedNow = new Date(Date.now() + offset);
  const y = shiftedNow.getUTCFullYear();
  const m = shiftedNow.getUTCMonth();
  const d = shiftedNow.getUTCDate() - daysAgo;
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - offset);
}

/** Inclusive list of YYYY-MM keys for the last N calendar months (oldest first). */
export function localMonthKeysForLastMonths(
  monthsCount: number,
  timeZone = DEFAULT_TZ,
): string[] {
  const keys: string[] = [];
  const offset = fixedOffsetMs(timeZone);
  const shiftedNow = new Date(Date.now() + offset);
  const y = shiftedNow.getUTCFullYear();
  const m = shiftedNow.getUTCMonth();

  for (let i = monthsCount - 1; i >= 0; i--) {
    const monthStartUtc = Date.UTC(y, m - i, 1, 0, 0, 0, 0) - offset;
    keys.push(localMonthKey(new Date(monthStartUtc), timeZone));
  }
  return keys;
}

/** Start instant of the first day of a YYYY-MM month in society local time. */
export function startOfLocalMonth(monthKey: string, timeZone = DEFAULT_TZ): Date {
  const offset = fixedOffsetMs(timeZone);
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0) - offset);
}
