import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeAmountDueForCycle,
  resolvePerCycleExpectedTotal,
  resolvePerCycleLateFee,
  resolveLedgerCycleExpected,
} from "./amountDue";

const juneCycle = {
  amount: 1100,
  lateFee: 50,
  paymentEndDate: new Date("2026-06-10T00:00:00.000Z"),
  gracePeriodDays: 5,
};

const julyCycle = {
  amount: 1100,
  lateFee: 0,
  paymentEndDate: new Date("2026-07-10T00:00:00.000Z"),
  gracePeriodDays: 5,
};

describe("resolvePerCycleLateFee", () => {
  it("applies billing-cycle late fee only after that cycle's grace", () => {
    const beforeGrace = new Date("2026-06-12T00:00:00.000Z");
    const afterGrace = new Date("2026-06-20T00:00:00.000Z");

    assert.equal(resolvePerCycleLateFee(juneCycle, null, beforeGrace, false), 0);
    assert.equal(resolvePerCycleLateFee(juneCycle, null, afterGrace, false), 50);
    assert.equal(resolvePerCycleLateFee(julyCycle, null, afterGrace, false), 0);
  });

  it("uses snapshot late fee for that cycle when cron applied it", () => {
    const snap = {
      expectedAmount: 1100,
      lateFeeAmount: 75,
      lateFeeAppliedAt: new Date("2026-06-16T00:00:00.000Z"),
    };
    assert.equal(resolvePerCycleLateFee(juneCycle, snap, new Date("2026-06-01T00:00:00.000Z"), false), 75);
  });

  it("waives late fee for a cycle without affecting base", () => {
    const afterGrace = new Date("2026-06-20T00:00:00.000Z");
    const totals = resolvePerCycleExpectedTotal(juneCycle, null, afterGrace, true);
    assert.equal(totals.lateFeeAmount, 0);
    assert.equal(totals.totalExpected, 1100);
  });
});

describe("resolveLedgerCycleExpected", () => {
  it("does not add billing-cycle late fee when snapshot base is already paid", () => {
    const afterGrace = new Date("2026-06-20T00:00:00.000Z");
    const snap = {
      expectedAmount: 1100,
      paidAmount: 1100,
      lateFeeAmount: 0,
      status: "PENDING",
    };
    const totals = resolveLedgerCycleExpected(juneCycle, snap, afterGrace, false);
    assert.equal(totals.lateFeeAmount, 0);
    assert.equal(totals.totalExpected, 1100);
  });

  it("adds billing-cycle late fee only when base is still unpaid after grace", () => {
    const afterGrace = new Date("2026-06-20T00:00:00.000Z");
    const snap = {
      expectedAmount: 1100,
      paidAmount: 0,
      lateFeeAmount: 0,
      status: "OVERDUE",
    };
    const totals = resolveLedgerCycleExpected(juneCycle, snap, afterGrace, false);
    assert.equal(totals.lateFeeAmount, 50);
    assert.equal(totals.totalExpected, 1150);
  });
});

describe("computeAmountDueForCycle", () => {
  it("computes total due per cycle independently", () => {
    const afterGrace = new Date("2026-06-20T00:00:00.000Z");
    const june = computeAmountDueForCycle(juneCycle, afterGrace, false);
    const july = computeAmountDueForCycle(julyCycle, afterGrace, false);
    assert.equal(june.lateFeeAmount, 50);
    assert.equal(june.totalDue, 1150);
    assert.equal(july.lateFeeAmount, 0);
    assert.equal(july.totalDue, 1100);
  });
});
