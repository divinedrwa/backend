/**
 * Society-local calendar helpers for analytics bucketing.
 * Production runs in UTC (Render); events must be grouped in society local time.
 */
const DEFAULT_TZ = process.env.SOCIETY_TIMEZONE?.trim() || "Asia/Kolkata";

export function societyTimeZone(): string {
  return DEFAULT_TZ;
}

/**
 * Offset (ms) to ADD to a UTC instant to obtain the zone's wall-clock time, at
 * the given instant. Derived from `Intl` so it works for any IANA zone and is
 * DST-aware (the offset is evaluated at `instant`, not assumed constant).
 * Positive for zones ahead of UTC — e.g. +5.5h for Asia/Kolkata.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24, // h23 yields 00–23, but guard against "24" just in case
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

/**
 * UTC instant corresponding to local wall-clock midnight of (year, month0, day)
 * in `timeZone`. `month0` is 0-based; out-of-range day/month values normalize
 * (e.g. day -1, month 13) via `Date.UTC`. DST-correct: the offset is resolved
 * at the target day, so day boundaries land right even across transitions.
 */
function zonedDayStartUtc(year: number, month0: number, day: number, timeZone: string): Date {
  const guessUtc = Date.UTC(year, month0, day, 0, 0, 0, 0);
  const offset = zoneOffsetMs(new Date(guessUtc), timeZone);
  return new Date(guessUtc - offset);
}

/** Current wall-clock Y/M/D in `timeZone`. */
function nowLocalParts(timeZone: string): { year: number; month0: number; day: number } {
  const now = new Date();
  const shifted = new Date(now.getTime() + zoneOffsetMs(now, timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month0: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
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
  const { year, month0, day } = nowLocalParts(timeZone);
  for (let i = daysCount - 1; i >= 0; i--) {
    keys.push(localDateKey(zonedDayStartUtc(year, month0, day - i, timeZone), timeZone));
  }
  return keys;
}

/** Start instant of the local calendar day that is `daysAgo` days before today (local). */
export function startOfLocalDayDaysAgo(
  daysAgo: number,
  timeZone = DEFAULT_TZ,
): Date {
  const { year, month0, day } = nowLocalParts(timeZone);
  return zonedDayStartUtc(year, month0, day - daysAgo, timeZone);
}

/** Inclusive list of YYYY-MM keys for the last N calendar months (oldest first). */
export function localMonthKeysForLastMonths(
  monthsCount: number,
  timeZone = DEFAULT_TZ,
): string[] {
  const keys: string[] = [];
  const { year, month0 } = nowLocalParts(timeZone);
  for (let i = monthsCount - 1; i >= 0; i--) {
    keys.push(localMonthKey(zonedDayStartUtc(year, month0 - i, 1, timeZone), timeZone));
  }
  return keys;
}

/** Start instant of the first day of a YYYY-MM month in society local time. */
export function startOfLocalMonth(monthKey: string, timeZone = DEFAULT_TZ): Date {
  const [y, m] = monthKey.split("-").map(Number);
  return zonedDayStartUtc(y, m - 1, 1, timeZone);
}
