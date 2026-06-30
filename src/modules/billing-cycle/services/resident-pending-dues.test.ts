import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pendingDuesToCurrentCycleShape, type UserPendingDueRow } from "./resident-pending-dues";

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
