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
  expectedAmount: number;
  lateFeeAmount: number;
}): number {
  let creditPool = params.unlinkedCredit;
  const expected = resolveSnapshotExpectedTotal(
    params.expectedAmount,
    params.lateFeeAmount,
  );
  creditPool = Math.max(0, params.cashPaid + creditPool - expected);
  return creditPool;
}

describe("credit walker pool with late fees", () => {
  it("consumes advance credit when cash + credit settles base + late fee", () => {
    const remaining = walkSingleCycleCreditPool({
      unlinkedCredit: 100,
      cashPaid: 1000,
      expectedAmount: 1000,
      lateFeeAmount: 100,
    });
    assert.equal(remaining, 0);
  });

  it("leaves stray credit when late fee is omitted from expected total", () => {
    const remaining = walkSingleCycleCreditPool({
      unlinkedCredit: 100,
      cashPaid: 1000,
      expectedAmount: 1000,
      lateFeeAmount: 0,
    });
    assert.equal(remaining, 100);
  });
});
