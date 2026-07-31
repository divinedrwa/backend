import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ShiftType } from "@prisma/client";
import { buildDailyRosterSlots } from "./guardShiftRoster.js";

describe("buildDailyRosterSlots", () => {
  it("creates 3 x 8h slots from 06:00", () => {
    const slots = buildDailyRosterSlots(8, 6 * 60);
    assert.equal(slots.length, 3);
    assert.equal(slots[0]!.shiftType, ShiftType.MORNING);
    assert.equal(slots[0]!.recurringStartMinutes, 360);
    assert.equal(slots[0]!.recurringEndMinutes, 840);
    assert.equal(slots[1]!.shiftType, ShiftType.EVENING);
    assert.equal(slots[1]!.recurringStartMinutes, 840);
    assert.equal(slots[1]!.recurringEndMinutes, 1320);
    assert.equal(slots[2]!.shiftType, ShiftType.NIGHT);
    assert.equal(slots[2]!.recurringStartMinutes, 1320);
    assert.equal(slots[2]!.recurringEndMinutes, 360);
  });

  it("creates 2 x 12h slots from 08:00", () => {
    const slots = buildDailyRosterSlots(12, 8 * 60);
    assert.equal(slots.length, 2);
    assert.equal(slots[0]!.shiftType, ShiftType.MORNING);
    assert.equal(slots[0]!.recurringStartMinutes, 480);
    assert.equal(slots[0]!.recurringEndMinutes, 1200);
    assert.equal(slots[1]!.shiftType, ShiftType.NIGHT);
    assert.equal(slots[1]!.recurringStartMinutes, 1200);
    assert.equal(slots[1]!.recurringEndMinutes, 480);
  });
});
