import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advanceCreditWalkStep } from "./snapshot-helpers";

/**
 * Regression: credit must propagate across FY boundaries (May FY1 → June FY2).
 * The walker uses advanceCreditWalkStep globally; this test locks the math
 * that caused A-09 June to stay at ₹200 when ₹900 credit was available.
 */
describe("credit walk cross-FY propagation", () => {
  it("May overpayment + manual ADJ pool applies to June with zero cash", () => {
    let pool = 0;

    // Jan–Apr manual ADJ injections (unlinked, injected at cycle start)
    pool += 100; // Jan ADJ
    pool = advanceCreditWalkStep(830, 830, pool).creditPool; // Jan exact pay

    pool += 200; // Feb ADJ
    pool = advanceCreditWalkStep(1100, 1100, pool).creditPool;

    pool += 200; // Mar ADJ
    pool = advanceCreditWalkStep(1100, 1100, pool).creditPool;

    pool += 200; // Apr ADJ
    pool = advanceCreditWalkStep(1100, 1100, pool).creditPool;

    // May: ₹1,300 bank, ₹1,100 due → +₹200 surplus
    const may = advanceCreditWalkStep(1100, 1300, pool);
    assert.equal(may.applied, 1100);
    assert.equal(may.creditPool, 900); // 700 ADJ + 200 May

    // June (possibly different FY): no cash, should consume ₹900 credit
    const june = advanceCreditWalkStep(1100, 0, may.creditPool);
    assert.equal(june.applied, 900);
    assert.equal(june.creditPool, 0);
  });

  it("single-FY May overpayment still flows to June", () => {
    const may = advanceCreditWalkStep(1100, 1300, 0);
    assert.equal(may.creditPool, 200);

    const june = advanceCreditWalkStep(1100, 0, may.creditPool);
    assert.equal(june.applied, 200);
    assert.equal(june.creditPool, 0);
  });
});
