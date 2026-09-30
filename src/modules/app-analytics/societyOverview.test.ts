import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countChange, formatDuration, formatRupees } from "./societyOverview.service.js";

describe("society overview formatting", () => {
  it("formats durations the way admins read them", () => {
    assert.equal(formatDuration(45), "45 min");
    assert.equal(formatDuration(69), "1 h 9 min");
    assert.equal(formatDuration(120), "2 h");
    assert.equal(formatDuration(27 * 24 * 60), "27 days");
  });

  it("formats rupees with Indian grouping", () => {
    assert.equal(formatRupees(125000), "₹1,25,000");
    assert.equal(formatRupees(0), "₹0");
  });

  it("describes count changes vs the previous period", () => {
    assert.deepEqual(countChange(7, 5), { label: "+40% vs before", direction: "up", good: true });
    assert.deepEqual(countChange(3, 6), { label: "−50% vs before", direction: "down", good: false });
    assert.deepEqual(countChange(2, 0), { label: "New this period", direction: "up", good: true });
    assert.equal(countChange(0, 0), null);
  });
});
