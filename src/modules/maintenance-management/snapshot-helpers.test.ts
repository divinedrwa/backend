import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advanceCreditWalkStep, resolveSnapshotExpectedTotal } from "./snapshot-helpers";

describe("resolveSnapshotExpectedTotal", () => {
  it("adds base maintenance and late fee", () => {
    assert.equal(resolveSnapshotExpectedTotal(1000, 100), 1100);
  });

  it("treats missing late fee as zero", () => {
    assert.equal(resolveSnapshotExpectedTotal(1000, null), 1000);
    assert.equal(resolveSnapshotExpectedTotal(1000), 1000);
  });
});

// These exercise the REAL walk-step used by every credit-walker variant —
// not a local re-implementation.
describe("advanceCreditWalkStep", () => {
  it("carries cash overpayment forward as credit", () => {
    const step = advanceCreditWalkStep(1000, 1500, 0);
    assert.equal(step.applied, 1000);
    assert.equal(step.creditPool, 500);
  });

  it("REGRESSION: prior credit survives a cycle fully covered by its own cash", () => {
    // Overpay cycle 1 by 500, then exact-pay cycle 2 in cash. The 500 is the
    // villa's money and must carry to cycle 3 — a buggy branch used to reset
    // the pool to max(0, cash − expected) whenever cash covered the cycle.
    const c1 = advanceCreditWalkStep(1000, 1500, 0);
    assert.equal(c1.creditPool, 500);
    const c2 = advanceCreditWalkStep(1000, 1000, c1.creditPool);
    assert.equal(c2.applied, 1000);
    assert.equal(c2.creditPool, 500);
    // Cycle 3 unpaid in cash — the surviving credit settles half of it.
    const c3 = advanceCreditWalkStep(1000, 0, c2.creditPool);
    assert.equal(c3.applied, 500);
    assert.equal(c3.creditPool, 0);
  });

  it("consumes credit when cash + credit settles base + late fee (divine_05)", () => {
    const step = advanceCreditWalkStep(1100, 1000, 100);
    assert.equal(step.applied, 1100);
    assert.equal(step.creditPool, 0);
  });

  it("leaves stray credit when walk expected omits the late fee", () => {
    const step = advanceCreditWalkStep(1000, 1000, 100);
    assert.equal(step.applied, 1000);
    assert.equal(step.creditPool, 100);
  });

  it("caps applied at expected and never returns a negative pool", () => {
    const short = advanceCreditWalkStep(1000, 200, 100);
    assert.equal(short.applied, 300);
    assert.equal(short.creditPool, 0);
  });

  it("nets negative unlinked adjustments (refunds) against available funds", () => {
    // A −300 adjustment injected into the pool reduces what this cycle can use.
    const step = advanceCreditWalkStep(1000, 800, -300);
    assert.equal(step.applied, 500);
    assert.equal(step.creditPool, 0);
  });

  it("conserves money: cash-in + pool-in === applied + pool-out", () => {
    for (const [expected, cash, pool] of [
      [1000, 1500, 0],
      [1000, 1000, 500],
      [1100, 1000, 100],
      [1000, 0, 250],
      [0, 400, 100],
    ] as const) {
      const step = advanceCreditWalkStep(expected, cash, pool);
      assert.equal(
        Math.round((step.applied + step.creditPool) * 100) / 100,
        Math.round((cash + pool) * 100) / 100,
        `not conserved for expected=${expected} cash=${cash} pool=${pool}`,
      );
    }
  });
});
