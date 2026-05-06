import type { GuardShift, Prisma, PrismaClient } from "@prisma/client";

/**
 * Half-open window [startM, endM) in minutes from midnight (local server time).
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
  const sm = s.startTime.getHours() * 60 + s.startTime.getMinutes();
  const em = s.endTime.getHours() * 60 + s.endTime.getMinutes();
  return { sm, em };
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

  const nm =
    now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  for (const s of recurringRows) {
    const pair = recurringMinutesFromStored(s);
    if (!pair) continue;
    if (isMinuteWithinRecurringWindow(nm, pair.sm, pair.em)) {
      return s;
    }
  }

  return null;
}
