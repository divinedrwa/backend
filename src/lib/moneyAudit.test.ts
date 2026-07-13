import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCycleReconciliationBreakdown } from "./reconciliation.js";

describe("money audit helpers", () => {
  it("re-exports reconciliation credit breakdown for UI consistency", () => {
    const b = computeCycleReconciliationBreakdown(1000, 600);
    assert.equal(b.creditApplied, 400);
    assert.equal(b.matched, true);
  });
});
