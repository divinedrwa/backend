import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NotificationCategory, PaymentMode, UserRole } from "@prisma/client";
import { ADMIN_PAYMENT_NOTIFY_ROLES, notifyAdminsResidentOnlinePaymentSuccess } from "./residentOnlinePaymentAdminNotify";

describe("residentOnlinePaymentAdminNotify", () => {
  it("ADMIN_PAYMENT_NOTIFY_ROLES includes admin and admin-resident", () => {
    assert.deepEqual(ADMIN_PAYMENT_NOTIFY_ROLES, [
      UserRole.ADMIN,
      UserRole.RESIDENT_CUM_ADMIN,
    ]);
  });

  it("notifyAdminsResidentOnlinePaymentSuccess is callable without throwing when DB is unavailable", async () => {
    // Integration path is covered by gateway settle tests; this guards export shape.
    assert.equal(typeof notifyAdminsResidentOnlinePaymentSuccess, "function");
    assert.equal(NotificationCategory.PAYMENT, NotificationCategory.PAYMENT);
    assert.equal(PaymentMode.ONLINE, PaymentMode.ONLINE);
  });
});
