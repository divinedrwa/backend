import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advanceCreditWalkStep } from "./snapshot-helpers";

/**
 * Display credit for an unpaid cycle must use pool *entering* that cycle,
 * not end-of-all-cycles pool (which future snapshots can zero out).
 */
describe("credit display semantics", () => {
  it("May surplus shows on May row; June unpaid shows entering credit not post-June zero", () => {
    let pool = 0;
    pool = advanceCreditWalkStep(1100, 1300, pool).creditPool; // May: +200
    assert.equal(pool, 200);

    const enteringJune = pool;
    const june = advanceCreditWalkStep(1100, 0, pool);
    assert.equal(enteringJune, 200);
    assert.equal(june.creditPool, 0);

    // July snapshot exists (future) — end pool stays 0 but June display uses enteringJune
    const july = advanceCreditWalkStep(1100, 0, june.creditPool);
    assert.equal(july.creditPool, 0);
    assert.equal(enteringJune, 200);
  });
});
