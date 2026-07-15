import { test } from "node:test";
import assert from "node:assert/strict";
import { NotificationCategory } from "@prisma/client";
import {
  ALWAYS_ON_CATEGORIES,
  MUTABLE_CATEGORIES,
  isCategoryMutable,
  pushAllowedForCategory,
} from "./notificationPreferences";

test("critical categories are never mutable", () => {
  assert.equal(isCategoryMutable(NotificationCategory.SOS), false);
  assert.equal(isCategoryMutable(NotificationCategory.PAYMENT), false);
  assert.equal(isCategoryMutable(NotificationCategory.SYSTEM), false);
});

test("non-critical categories are mutable", () => {
  assert.equal(isCategoryMutable(NotificationCategory.NOTICE), true);
  assert.equal(isCategoryMutable(NotificationCategory.VISITOR), true);
  assert.equal(isCategoryMutable(NotificationCategory.MAINTENANCE), true);
});

test("MUTABLE_CATEGORIES excludes exactly the always-on set", () => {
  for (const c of MUTABLE_CATEGORIES) {
    assert.equal(ALWAYS_ON_CATEGORIES.has(c), false);
  }
  const total = Object.values(NotificationCategory).length;
  assert.equal(MUTABLE_CATEGORIES.length, total - ALWAYS_ON_CATEGORIES.size);
});

test("critical categories push even when present in the muted set", () => {
  const muted = new Set<NotificationCategory>([
    NotificationCategory.SOS,
    NotificationCategory.PAYMENT,
  ]);
  assert.equal(pushAllowedForCategory(NotificationCategory.SOS, muted), true);
  assert.equal(pushAllowedForCategory(NotificationCategory.PAYMENT, muted), true);
});

test("mutable category is suppressed only when muted", () => {
  const muted = new Set<NotificationCategory>([NotificationCategory.NOTICE]);
  assert.equal(pushAllowedForCategory(NotificationCategory.NOTICE, muted), false);
  assert.equal(pushAllowedForCategory(NotificationCategory.VISITOR, muted), true);
});
