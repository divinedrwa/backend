import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isWaterTurnedOff, isWaterTurnedOn } from "./waterEventAction";

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
});
