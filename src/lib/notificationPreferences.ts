import { NotificationCategory } from "@prisma/client";

/**
 * L3 — per-category notification preferences.
 *
 * Residents can mute push for non-critical categories. Critical categories are
 * ALWAYS delivered (subject only to the global `notifyPush` switch and having a
 * device) and cannot be muted — a resident must not be able to silence an SOS or a
 * payment confirmation. In-app inbox rows are always persisted regardless of push.
 */

/** Categories that can never be muted — always attempt push. */
export const ALWAYS_ON_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([
  NotificationCategory.SOS,
  NotificationCategory.PAYMENT,
  NotificationCategory.SYSTEM,
]);

/** Categories a resident may opt out of, in a stable display order. */
export const MUTABLE_CATEGORIES: readonly NotificationCategory[] = Object.values(
  NotificationCategory,
).filter((c) => !ALWAYS_ON_CATEGORIES.has(c));

export function isCategoryMutable(category: NotificationCategory): boolean {
  return !ALWAYS_ON_CATEGORIES.has(category);
}

/**
 * Whether push should be attempted for a category given the user's muted set.
 * Non-mutable categories always return true; mutable ones return false only when
 * the user has explicitly muted them.
 */
export function pushAllowedForCategory(
  category: NotificationCategory,
  mutedCategories: ReadonlySet<NotificationCategory>,
): boolean {
  if (!isCategoryMutable(category)) return true;
  return !mutedCategories.has(category);
}
