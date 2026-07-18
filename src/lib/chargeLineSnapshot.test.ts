import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChargeLinesFromBreakdown } from "./chargeLineSnapshot.js";

describe("chargeLineSnapshot", () => {
  it("parses chargeLines array from snapshot breakdown JSON", () => {
    const lines = parseChargeLinesFromBreakdown({
      billingSource: "chargeHeads",
      chargeLines: [
        { label: "Maintenance", code: "maintenance", amount: 1000, sortOrder: 0 },
        { label: "Sinking fund", code: "sinking", amount: 200, sortOrder: 1 },
      ],
      totalAmount: 1200,
    });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].label, "Maintenance");
    assert.equal(lines[1].amount, 200);
  });

  it("returns empty for legacy breakdown without chargeLines", () => {
    assert.deepEqual(parseChargeLinesFromBreakdown({ ruleType: "FIXED_PER_FLAT" }), []);
    assert.deepEqual(parseChargeLinesFromBreakdown(null), []);
  });
});
