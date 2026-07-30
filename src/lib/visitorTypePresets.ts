import type { VisitorType } from "@prisma/client";

/**
 * Default pass lifetime when the client omits `validUntil`.
 * Cab/delivery are intentionally short; guests get a full day.
 */
export const VISITOR_TYPE_DEFAULT_VALIDITY_HOURS: Partial<
  Record<VisitorType, number>
> = {
  GUEST: 24,
  DELIVERY: 4,
  CAB: 2,
  SERVICE_PROVIDER: 8,
  VENDOR: 24,
  CONTRACTOR: 8,
  OTHER: 24,
};

/** Human labels for push / SMS / UI. */
export const VISITOR_TYPE_LABEL: Record<string, string> = {
  GUEST: "Guest",
  DELIVERY: "Delivery",
  CAB: "Cab",
  SERVICE_PROVIDER: "Service provider",
  VENDOR: "Vendor",
  CONTRACTOR: "Contractor",
  OTHER: "Other",
};

/** Types accepted on pre-approve + guard check-in APIs (primary + legacy). */
export const VISITOR_TYPE_API_VALUES = [
  "GUEST",
  "DELIVERY",
  "CAB",
  "SERVICE_PROVIDER",
  "VENDOR",
] as const;

export type VisitorTypeApiValue = (typeof VISITOR_TYPE_API_VALUES)[number];

export function defaultValidUntilForVisitorType(
  visitorType: VisitorType | string | undefined | null,
  from: Date = new Date(),
): Date {
  const key = (visitorType ?? "GUEST") as VisitorType;
  const hours = VISITOR_TYPE_DEFAULT_VALIDITY_HOURS[key] ?? 24;
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

export function visitorTypeLabel(visitorType: string | undefined | null): string {
  const key = (visitorType ?? "GUEST").trim();
  return VISITOR_TYPE_LABEL[key] ?? key.replace(/_/g, " ");
}

/** Minutes inside society before overstay alert (from check-in). */
export const VISITOR_TYPE_OVERSTAY_MINUTES: Partial<Record<VisitorType, number>> = {
  DELIVERY: 45,
  CAB: 30,
  SERVICE_PROVIDER: 120,
  GUEST: 240,
  VENDOR: 180,
  CONTRACTOR: 180,
  OTHER: 240,
};

export function expectedCheckoutAtForVisitorType(
  visitorType: VisitorType | string | undefined | null,
  checkInAt: Date = new Date(),
): Date {
  const key = (visitorType ?? "GUEST") as VisitorType;
  const minutes = VISITOR_TYPE_OVERSTAY_MINUTES[key] ?? 240;
  return new Date(checkInAt.getTime() + minutes * 60 * 1000);
}
