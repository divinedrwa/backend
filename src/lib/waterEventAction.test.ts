import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UserRole } from "@prisma/client";
import {
  buildWaterStillOnReminder,
  buildWaterToggleNotification,
  isWaterTurnedOff,
  isWaterTurnedOn,
  WATER_STILL_ON_NOTIFY_ROLES,
  WATER_SUPPLY_ON_NOTIFICATION,
  waterStillOnReminderMinutes,
} from "./waterEventAction";

describe("waterEventAction", () => {
  it("prefers turnedOn boolean", () => {
    assert.equal(isWaterTurnedOn({ turnedOn: true, action: "TURNED_OFF" }), true);
    assert.equal(isWaterTurnedOff({ turnedOn: false, action: "TURNED_ON" }), true);
  });

  it("accepts legacy ON/OFF and current TURNED_ON/TURNED_OFF action strings", () => {
    assert.equal(isWaterTurnedOn({ action: "TURNED_ON" }), true);
    assert.equal(isWaterTurnedOn({ action: "ON" }), true);
    assert.equal(isWaterTurnedOff({ action: "TURNED_OFF" }), true);
    assert.equal(isWaterTurnedOff({ action: "OFF" }), true);
  });

  it("buildWaterToggleNotification — ON notifies residents with fixed copy", () => {
    const n = buildWaterToggleNotification({
      turnedOn: true,
      gateName: "Main Gate",
      reason: "Should be ignored for ON",
    });
    assert.equal(n.title, WATER_SUPPLY_ON_NOTIFICATION.title);
    assert.equal(n.body, WATER_SUPPLY_ON_NOTIFICATION.body);
    assert.equal(n.type, "WATER_SUPPLY_ON");
    assert.ok(n.roles.includes(UserRole.RESIDENT));
    assert.ok(n.roles.includes(UserRole.ADMIN));
  });

  it("buildWaterToggleNotification — OFF notifies admins only", () => {
    const n = buildWaterToggleNotification({
      turnedOn: false,
      gateName: "North Gate",
    });
    assert.ok(!n.roles.includes(UserRole.RESIDENT));
    assert.ok(!n.roles.includes(UserRole.GUARD));
    assert.deepEqual(n.roles, [UserRole.ADMIN, UserRole.RESIDENT_CUM_ADMIN]);
    assert.equal(n.title, "Water supply OFF");
    assert.equal(n.type, "WATER_SUPPLY_OFF");
    assert.match(n.body, /North Gate/);
  });

  it("buildWaterStillOnReminder reminds to check tank and switch OFF", () => {
    const n = buildWaterStillOnReminder({ gateName: "Main Gate", minutesOn: 30 });
    assert.equal(n.type, "WATER_SUPPLY_STILL_ON");
    assert.equal(n.title, "Water motor still ON");
    assert.match(n.body, /Main Gate/);
    assert.match(n.body, /30\+/);
    assert.match(n.body, /tank is full/i);
    assert.match(n.body, /switch the motor OFF/i);
  });

  it("WATER_STILL_ON_NOTIFY_ROLES include guards and admins", () => {
    assert.deepEqual(WATER_STILL_ON_NOTIFY_ROLES, [
      UserRole.GUARD,
      UserRole.ADMIN,
      UserRole.RESIDENT_CUM_ADMIN,
    ]);
  });

  it("waterStillOnReminderMinutes defaults to 30", () => {
    const prev = process.env.WATER_STILL_ON_REMINDER_MINUTES;
    delete process.env.WATER_STILL_ON_REMINDER_MINUTES;
    assert.equal(waterStillOnReminderMinutes(), 30);
    process.env.WATER_STILL_ON_REMINDER_MINUTES = "5";
    assert.equal(waterStillOnReminderMinutes(), 5);
    process.env.WATER_STILL_ON_REMINDER_MINUTES = "0";
    assert.equal(waterStillOnReminderMinutes(), 30);
    if (prev === undefined) delete process.env.WATER_STILL_ON_REMINDER_MINUTES;
    else process.env.WATER_STILL_ON_REMINDER_MINUTES = prev;
  });
});
