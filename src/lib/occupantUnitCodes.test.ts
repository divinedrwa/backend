import test from "node:test";
import assert from "node:assert/strict";
import {
  occupantUnitCodeForFloorIndex,
  occupantUnitCodeStem,
  legacyOccupantUnitCodeForFloorIndex,
  inferCanonicalTierIndex,
  nextFreeOccupantSlotIndex,
  suggestedOccupantUnitDefinitions,
} from "./occupantUnitCodes";

test("occupantUnitCodeStem avoids double V for V-03 style numbers", () => {
  assert.equal(occupantUnitCodeStem("V-03"), "V03");
  assert.equal(occupantUnitCodeStem("v 03"), "V03");
  assert.equal(occupantUnitCodeForFloorIndex("V-03", 0), "V03_GF");
  assert.equal(occupantUnitCodeForFloorIndex("V-03", 1), "V03_FF");
});

test("numeric-only villa numbers get a single leading V", () => {
  assert.equal(occupantUnitCodeStem("03"), "V03");
  assert.equal(occupantUnitCodeForFloorIndex("03", 0), "V03_GF");
  assert.equal(occupantUnitCodeStem("3"), "V03");
  assert.equal(occupantUnitCodeForFloorIndex("3", 0), "V03_GF");
});

test("non-V prefixes get V prepended once", () => {
  assert.equal(occupantUnitCodeStem("A-101"), "VA101");
  assert.equal(occupantUnitCodeForFloorIndex("A-101", 2), "VA101_SF");
});

test("legacy VV03_GF maps to tier 0 for same villa number", () => {
  assert.equal(inferCanonicalTierIndex("V-03", "VV03_GF"), 0);
  assert.equal(inferCanonicalTierIndex("V-03", "V03_GF"), 0);
});

test("legacy matches old generator for first floor", () => {
  assert.equal(legacyOccupantUnitCodeForFloorIndex("V-03", 1), "VV03_FF");
  assert.equal(inferCanonicalTierIndex("V-03", "VV03_FF"), 1);
});

test("inferCanonicalTierIndex matches higher suffix slots", () => {
  assert.equal(inferCanonicalTierIndex("V-03", "V03_F10"), 9);
});

test("nextFreeOccupantSlotIndex skips occupied slots", () => {
  assert.equal(nextFreeOccupantSlotIndex(new Set([0, 1, 2])), 3);
  assert.equal(nextFreeOccupantSlotIndex(new Set()), 0);
});

test("suggestedOccupantUnitDefinitions length follows floors", () => {
  assert.equal(suggestedOccupantUnitDefinitions("X-1", 1).length, 1);
  assert.equal(suggestedOccupantUnitDefinitions("X-1", 3).length, 3);
  assert.equal(suggestedOccupantUnitDefinitions("X-1", 3)[2]!.unitCode, "VX1_SF");
});
