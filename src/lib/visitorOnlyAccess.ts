import { NotificationCategory, UserRole } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { loadAppVisibleBillingCyclePeriodKeys } from "../modules/billing-cycle/billing-collection-scope";
import { prisma } from "./prisma";

/**
 * Residents of a villa that doesn't pay maintenance (`Villa.maintenanceExemptFromPeriod` set)
 * use the app for visitor management only — once the villa has cleared the dues raised before
 * billing stopped (see `villaIdsWithUnpaidDues`). Admin-like roles are never restricted.
 */
export function isVisitorOnlyResident(
  role: unknown,
  villaExemptFromPeriod: unknown,
  villaHasUnpaidDues = false,
): boolean {
  return (
    role === UserRole.RESIDENT &&
    typeof villaExemptFromPeriod === "string" &&
    villaExemptFromPeriod.length > 0 &&
    !villaHasUnpaidDues
  );
}

/**
 * Of the given villas, those still owing on a cycle residents can see in the app. A villa whose
 * billing stopped keeps full app access (payments, reminders) until these old dues are paid.
 */
export async function villaIdsWithUnpaidDues(villaIds: string[]): Promise<Set<string>> {
  if (villaIds.length === 0) return new Set();
  const snapshots = await prisma.villaMaintenanceSnapshot.findMany({
    where: { villaId: { in: villaIds }, status: { notIn: ["PAID", "WAIVED"] } },
    select: {
      villaId: true,
      expectedAmount: true,
      lateFeeAmount: true,
      paidAmount: true,
      cycle: { select: { societyId: true, periodKey: true } },
    },
  });
  const owing = snapshots.filter(
    (s) => Number(s.expectedAmount) + Number(s.lateFeeAmount ?? 0) - Number(s.paidAmount) > 0,
  );
  if (owing.length === 0) return new Set();

  const visibleKeys = new Map<string, Set<string>>();
  for (const societyId of new Set(owing.map((s) => s.cycle.societyId))) {
    visibleKeys.set(societyId, new Set(await loadAppVisibleBillingCyclePeriodKeys(prisma, societyId)));
  }
  return new Set(
    owing
      .filter((s) => visibleKeys.get(s.cycle.societyId)?.has(s.cycle.periodKey))
      .map((s) => s.villaId),
  );
}

/** Visitor-only check for a resident whose villa is already loaded. */
export async function isVisitorOnlyForVilla(
  role: unknown,
  villa: { id?: string | null; maintenanceExemptFromPeriod?: string | null } | null | undefined,
): Promise<boolean> {
  if (!isVisitorOnlyResident(role, villa?.maintenanceExemptFromPeriod)) return false;
  if (!villa?.id) return true;
  return !(await villaIdsWithUnpaidDues([villa.id])).has(villa.id);
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
    select: { role: true, villa: { select: { id: true, maintenanceExemptFromPeriod: true } } },
  });
  return isVisitorOnlyForVilla(user?.role, user?.villa);
}

/**
 * Express middleware: refuses the guarded write methods for visitor-only residents. The app
 * already hides these screens; this stops older app builds or direct API calls. Mount after
 * `requireAuth` (reads `req.auth`); reads always pass so background app requests keep working.
 */
export function blockVisitorOnlyWrites(methods: string[] = ["POST"]) {
  const guarded = new Set(methods.map((m) => m.toUpperCase()));
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = req.auth;
      if (!guarded.has(req.method.toUpperCase()) || auth?.role !== UserRole.RESIDENT) return next();
      if (await isVisitorOnlyUser(auth.userId)) {
        res.status(403).json({
          message: "Your villa is set up for visitor management only. Please contact the society office.",
        });
        return;
      }
      next();
    } catch (e) {
      next(e);
    }
  };
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
    select: { id: true, villaId: true },
  });
  if (restricted.length === 0) return userIds;
  // Villas still clearing old dues keep getting billing reminders and other notices.
  const owing = await villaIdsWithUnpaidDues([
    ...new Set(restricted.map((u) => u.villaId).filter((v): v is string => !!v)),
  ]);
  const skip = new Set(restricted.filter((u) => !u.villaId || !owing.has(u.villaId)).map((u) => u.id));
  return userIds.filter((id) => !skip.has(id));
}
