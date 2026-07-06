import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSnapshotExpectedTotal } from "./snapshot-helpers";

describe("resolveSnapshotExpectedTotal", () => {
  it("adds base maintenance and late fee", () => {
    assert.equal(resolveSnapshotExpectedTotal(1000, 100), 1100);
  });

  it("treats missing late fee as zero", () => {
    assert.equal(resolveSnapshotExpectedTotal(1000, null), 1000);
    assert.equal(resolveSnapshotExpectedTotal(1000), 1000);
  });
});

/** Mirrors credit-walker pool math for a single cycle (regression for divine_05 scenario). */
function walkSingleCycleCreditPool(params: {
  unlinkedCredit: number;
  cashPaid: number;
  walkExpected: number;
}): number {
  let creditPool = params.unlinkedCredit;
  creditPool = Math.max(0, params.cashPaid + creditPool - params.walkExpected);
  return creditPool;
}

describe("credit walker pool with late fees", () => {
  it("consumes advance credit when cash + credit settles base + late fee", () => {
    const remaining = walkSingleCycleCreditPool({
      unlinkedCredit: 100,
      cashPaid: 1000,
      walkExpected: 1100,
    });
    assert.equal(remaining, 0);
  });

  it("leaves stray credit when walk expected omits late fee", () => {
    const remaining = walkSingleCycleCreditPool({
      unlinkedCredit: 100,
      cashPaid: 1000,
      walkExpected: 1000,
    });
    assert.equal(remaining, 100);
  });
});
