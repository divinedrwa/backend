import type { GuardShift, Prisma, PrismaClient } from "@prisma/client";

/** IST is UTC+5:30 = 330 minutes ahead. */
const IST_OFFSET_MINUTES = 330;

/** Convert a Date to IST minute-of-day (0-1439). */
function toIstMinuteOfDay(d: Date): number {
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  return (utcMin + IST_OFFSET_MINUTES) % 1440;
}

/**
 * Half-open window [startM, endM) in minutes from midnight (IST).
 * Overnight: startM > endM means e.g. 22:00–06:00.
 */
export function isMinuteWithinRecurringWindow(
  nowMinutes: number,
  startM: number,
  endM: number,
): boolean {
  if (startM === endM) {
    return false;
  }
  if (startM < endM) {
    return nowMinutes >= startM && nowMinutes < endM;
  }
  return nowMinutes >= startM || nowMinutes < endM;
}

function recurringMinutesFromStored(s: GuardShift): { sm: number; em: number } | null {
  if (s.recurringStartMinutes != null && s.recurringEndMinutes != null) {
    return { sm: s.recurringStartMinutes, em: s.recurringEndMinutes };
  }
  const sm = toIstMinuteOfDay(s.startTime);
  const em = toIstMinuteOfDay(s.endTime);
  return { sm, em };
}

const activeShiftInclude = {
  guard: { select: { id: true, name: true, username: true, phone: true, isActive: true } },
  gate: { select: { id: true, name: true, location: true } },
} satisfies Prisma.GuardShiftInclude;

export type ActiveGuardShift = Prisma.GuardShiftGetPayload<{
  include: typeof activeShiftInclude;
}>;

function filterRecurringActive(
  rows: GuardShift[],
  nowMinutes: number,
): GuardShift[] {
  const out: GuardShift[] = [];
  for (const s of rows) {
    const pair = recurringMinutesFromStored(s);
    if (!pair) continue;
    if (isMinuteWithinRecurringWindow(nowMinutes, pair.sm, pair.em)) {
      out.push(s);
    }
  }
  return out;
}

/**
 * All guard shifts active right now for a society (optionally scoped to one gate).
 */
export async function findActiveShiftsForSociety(
  prisma: PrismaClient,
  params: {
    societyId: string;
    now?: Date;
    gateId?: string;
    include?: Prisma.GuardShiftInclude;
  },
): Promise<ActiveGuardShift[]> {
  const now = params.now ?? new Date();
  const include = params.include ?? activeShiftInclude;
  const baseWhere: Prisma.GuardShiftWhereInput = {
    societyId: params.societyId,
    ...(params.gateId ? { gateId: params.gateId } : {}),
  };

  const [absolute, recurringRows] = await Promise.all([
    prisma.guardShift.findMany({
      where: {
        ...baseWhere,
        recurringDaily: false,
        startTime: { lte: now },
        endTime: { gte: now },
      },
      include,
      orderBy: { startTime: "desc" },
    }),
    prisma.guardShift.findMany({
      where: { ...baseWhere, recurringDaily: true },
      include,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const nm = toIstMinuteOfDay(now);
  return [...absolute, ...filterRecurringActive(recurringRows, nm)] as ActiveGuardShift[];
}

export async function findActiveGuardShiftAtGate(
  prisma: PrismaClient,
  params: {
    gateId: string;
    societyId: string;
    now?: Date;
    include?: Prisma.GuardShiftInclude;
  },
): Promise<ActiveGuardShift | null> {
  const rows = await findActiveShiftsForSociety(prisma, {
    societyId: params.societyId,
    gateId: params.gateId,
    now: params.now,
    include: params.include,
  });
  return rows[0] ?? null;
}

/**
 * Active shift: either a one-off row containing `now`, or a recurring daily template whose window contains `now`.
 */
export async function findActiveGuardShift(
  prisma: PrismaClient,
  params: {
    guardId: string;
    societyId: string;
    now?: Date;
    include?: Prisma.GuardShiftInclude;
  },
): Promise<GuardShift | null> {
  const now = params.now ?? new Date();
  const include = params.include;

  const absolute = await prisma.guardShift.findFirst({
    where: {
      guardId: params.guardId,
      societyId: params.societyId,
      recurringDaily: false,
      startTime: { lte: now },
      endTime: { gte: now },
    },
    include,
    orderBy: { startTime: "desc" },
  });
  if (absolute) {
    return absolute;
  }

  const recurringRows = await prisma.guardShift.findMany({
    where: {
      guardId: params.guardId,
      societyId: params.societyId,
      recurringDaily: true,
    },
    include,
    orderBy: { createdAt: "desc" },
  });

  const nm = toIstMinuteOfDay(now);

  for (const s of recurringRows) {
    const pair = recurringMinutesFromStored(s);
    if (!pair) continue;
    if (isMinuteWithinRecurringWindow(nm, pair.sm, pair.em)) {
      return s;
    }
  }

  return null;
}
