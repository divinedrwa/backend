import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UserRole } from "@prisma/client";
import {
  buildWaterToggleNotification,
  isWaterTurnedOff,
  isWaterTurnedOn,
  WATER_SUPPLY_ON_NOTIFICATION,
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
});
