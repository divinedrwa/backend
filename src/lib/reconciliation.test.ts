import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeCycleReconciliationBreakdown,
  isReconciliationCycleMatched,
} from "./reconciliation";

describe("reconciliation auto-heal helpers", () => {
  it("matches within 1 paisa tolerance", () => {
    assert.equal(isReconciliationCycleMatched(1000, 1000), true);
    assert.equal(isReconciliationCycleMatched(1000, 1000.009), true);
    assert.equal(isReconciliationCycleMatched(1000, 1000.02), false);
  });
});

describe("computeCycleReconciliationBreakdown (A6)", () => {
  it("treats snapshot credit gap as matched, not an alert", () => {
    const b = computeCycleReconciliationBreakdown(500, 300);
    assert.equal(b.matched, true);
    assert.equal(b.creditApplied, 200);
    assert.equal(b.unexplainedDifference, 0);
    assert.equal(b.alertDifference, 0);
  });

  it("flags excess cash over snapshot settled total", () => {
    const b = computeCycleReconciliationBreakdown(300, 500);
    assert.equal(b.matched, false);
    assert.equal(b.creditApplied, 0);
    assert.equal(b.unexplainedDifference, 200);
    assert.equal(b.alertDifference, 200);
  });
});
