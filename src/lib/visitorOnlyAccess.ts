import { NotificationCategory, UserRole } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Residents of a villa that doesn't pay maintenance (`Villa.maintenanceExemptFromPeriod` set)
 * use the app for visitor management only. Admin-like roles are never restricted.
 */
export function isVisitorOnlyResident(role: unknown, villaExemptFromPeriod: unknown): boolean {
  return role === UserRole.RESIDENT && typeof villaExemptFromPeriod === "string" && villaExemptFromPeriod.length > 0;
}

/** Gate-related notifications a visitor-only resident still receives (SOS kept for safety). */
export const VISITOR_ONLY_NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  NotificationCategory.VISITOR,
  NotificationCategory.PARCEL,
  NotificationCategory.SOS,
];
const VISITOR_ONLY_CATEGORIES = new Set<NotificationCategory>(VISITOR_ONLY_NOTIFICATION_CATEGORIES);

/** True when this signed-in user is a visitor-only resident. */
export async function isVisitorOnlyUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, villa: { select: { maintenanceExemptFromPeriod: true } } },
  });
  return isVisitorOnlyResident(user?.role, user?.villa?.maintenanceExemptFromPeriod);
}

export function isNotificationAllowedForVisitorOnly(
  category: NotificationCategory | undefined,
  data?: Record<string, unknown> | null,
): boolean {
  if (category && VISITOR_ONLY_CATEGORIES.has(category)) return true;
  // Some gate pushes are sent without a category; fall back to their data type.
  const type = typeof data?.type === "string" ? data.type.toUpperCase() : "";
  return type.startsWith("VISITOR") || type.startsWith("PARCEL") || type.startsWith("SOS");
}

/** Drops visitor-only residents from a recipient list when the notification isn't for them. */
export async function withoutVisitorOnlyRecipients(
  userIds: string[],
  category: NotificationCategory | undefined,
  data?: Record<string, unknown> | null,
): Promise<string[]> {
  if (userIds.length === 0 || isNotificationAllowedForVisitorOnly(category, data)) return userIds;
  const restricted = await prisma.user.findMany({
    where: {
      id: { in: userIds },
      role: UserRole.RESIDENT,
      villa: { maintenanceExemptFromPeriod: { not: null } },
    },
    select: { id: true },
  });
  if (restricted.length === 0) return userIds;
  const skip = new Set(restricted.map((u) => u.id));
  return userIds.filter((id) => !skip.has(id));
}
