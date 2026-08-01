import { VisitorStatus } from "@prisma/client";
import { localDayRange as societyLocalDayRange } from "./societyTime";

type VisitorCheckoutFields = {
  checkOutTime?: Date | string | null;
  checkOutAt?: Date | string | null;
  status?: VisitorStatus | string | null;
};

type VisitorCheckinFields = {
  checkInTime?: Date | string | null;
  checkInAt?: Date | string | null;
};

type VisitorPresenceFields = VisitorCheckoutFields & {
  status?: VisitorStatus | string | null;
};

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True when the visitor has left the society (either alias timestamp or status). */
export function visitorIsCheckedOut(visitor: VisitorCheckoutFields): boolean {
  if (visitor.checkOutTime || visitor.checkOutAt) return true;
  return visitor.status === VisitorStatus.CHECKED_OUT;
}

/** True when the visitor is on premises now (any entry path: walk-in, OTP, pre-approved, etc.). */
export function visitorIsInside(visitor: VisitorPresenceFields): boolean {
  if (visitorIsCheckedOut(visitor)) return false;
  return visitor.status === VisitorStatus.CHECKED_IN;
}

export function visitorCheckInDate(visitor: VisitorCheckinFields): Date | null {
  return toDate(visitor.checkInTime ?? visitor.checkInAt);
}

export function visitorCheckOutDate(visitor: VisitorCheckoutFields): Date | null {
  return toDate(visitor.checkOutTime ?? visitor.checkOutAt);
}

/** Society-local calendar day bounds (Asia/Kolkata by default). */
export function localDayRange(now = new Date()): { start: Date; end: Date } {
  return societyLocalDayRange(now);
}

export function visitorCheckedInOnDay(
  visitor: VisitorCheckinFields,
  day: Date = new Date(),
): boolean {
  const checkIn = visitorCheckInDate(visitor);
  if (!checkIn) return false;
  const { start, end } = localDayRange(day);
  return checkIn >= start && checkIn <= end;
}

export function summarizeVisitorsToday<
  T extends VisitorCheckinFields & VisitorPresenceFields,
>(visitors: T[], day: Date = new Date()) {
  const today = visitors.filter((v) => visitorCheckedInOnDay(v, day));
  const checkedIn = today.filter((v) => visitorIsInside(v));
  const checkedOut = today.filter((v) => visitorIsCheckedOut(v));
  return {
    total: today.length,
    checkedIn: checkedIn.length,
    checkedOut: checkedOut.length,
  };
}
