import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pendingDuesToCurrentCycleShape,
  computeRemainingDueFromLedgerRow,
  type UserPendingDueRow,
} from "./resident-pending-dues";

describe("computeRemainingDueFromLedgerRow", () => {
  it("subtracts advance credit already applied to the snapshot", () => {
    // A-09 June: exp 1100, cash 0, ₹200 credit from May overpayment → ₹900 due
    assert.equal(
      computeRemainingDueFromLedgerRow({ expectedAmount: 1100, cashPaidAmount: 0, creditApplied: 200 }),
      900,
    );
  });

  it("returns zero when credit fully settles the cycle (A-05 June)", () => {
    assert.equal(
      computeRemainingDueFromLedgerRow({ expectedAmount: 1100, cashPaidAmount: 1000, creditApplied: 100 }),
      0,
    );
  });
});

describe("pendingDuesToCurrentCycleShape", () => {
  it("maps ledger pending rows to /v1/cycles/current pendingDues shape", () => {
    const rows: UserPendingDueRow[] = [
      {
        cycleId: "c1",
        cycleKey: "2025-01",
        title: "Jan 2025",
        amount: 500,
        expectedAmount: 500,
        baseExpectedAmount: 500,
        lateFeeAmount: 0,
        remainingDue: 500,
        paymentEndDate: "2025-01-31T00:00:00.000Z",
        gracePeriodDays: 7,
        isGraceOver: false,
        isOverdue: true,
        status: "CLOSED",
      },
      {
        cycleId: "c2",
        cycleKey: "2025-02",
        title: "Feb 2025",
        amount: 600,
        expectedAmount: 600,
        baseExpectedAmount: 600,
        lateFeeAmount: 0,
        remainingDue: 600,
        paymentEndDate: "2025-02-28T00:00:00.000Z",
        gracePeriodDays: 7,
        isGraceOver: true,
        isOverdue: true,
        status: "CLOSED",
      },
    ];

    const out = pendingDuesToCurrentCycleShape(rows);
    assert.equal(out.length, 2);
    assert.equal(out[0]?.cycleKey, "2025-01");
    assert.equal(out[0]?.amount, 500);
    assert.equal(out[1]?.isGraceOver, true);
  });
});
