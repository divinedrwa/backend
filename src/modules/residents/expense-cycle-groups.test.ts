import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildExpenseBillingCycleGroups,
  cyclePhaseForExpenseGroup,
  expensePeriodKey,
} from "./expense-cycle-groups";

describe("expensePeriodKey", () => {
  it("uses month/year when set", () => {
    assert.equal(
      expensePeriodKey({
        month: 7,
        year: 2026,
        paymentDate: new Date("2026-06-01T00:00:00.000Z"),
      }),
      "2026-07",
    );
  });
});

describe("buildExpenseBillingCycleGroups", () => {
  const cycle = {
    id: "c1",
    cycleKey: "2026-07",
    title: "July 2026 Maintenance",
    publishedAt: null,
    paymentStartDate: new Date("2026-08-01T00:00:00.000Z"),
    paymentEndDate: new Date("2026-08-15T00:00:00.000Z"),
  };

  it("groups expenses under billing cycle with DRAFT phase", () => {
    const groups = buildExpenseBillingCycleGroups({
      expenses: [
        {
          id: "e1",
          title: "Electricity",
          amount: { toString: () => "1000" } as never,
          netAmount: { toString: () => "1000" } as never,
          paymentDate: new Date("2026-07-16T00:00:00.000Z"),
          paymentMode: "UPI",
          paidTo: "NPCL",
          month: 7,
          year: 2026,
          status: "APPROVED",
          createdAt: new Date(),
          category: null,
          attachmentCount: 0,
        },
      ],
      cycles: [cycle],
      nowUtc: new Date("2026-07-16T00:00:00.000Z"),
    });

    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.phase, "DRAFT");
    assert.equal(groups[0]!.expenseCount, 1);
    assert.equal(groups[0]!.totalAmount, 1000);
  });

  it("sorts groups newest cycle first", () => {
    const groups = buildExpenseBillingCycleGroups({
      expenses: [
        {
          id: "e1",
          title: "May",
          amount: { toString: () => "100" } as never,
          netAmount: { toString: () => "100" } as never,
          paymentDate: new Date("2026-05-10T00:00:00.000Z"),
          paymentMode: "CASH",
          paidTo: "X",
          month: 5,
          year: 2026,
          status: "APPROVED",
          createdAt: new Date(),
          category: null,
          attachmentCount: 0,
        },
        {
          id: "e2",
          title: "Jul",
          amount: { toString: () => "200" } as never,
          netAmount: { toString: () => "200" } as never,
          paymentDate: new Date("2026-07-10T00:00:00.000Z"),
          paymentMode: "CASH",
          paidTo: "Y",
          month: 7,
          year: 2026,
          status: "APPROVED",
          createdAt: new Date(),
          category: null,
          attachmentCount: 0,
        },
      ],
      cycles: [
        cycle,
        {
          ...cycle,
          id: "c2",
          cycleKey: "2026-05",
          title: "May 2026",
          publishedAt: new Date("2026-05-01T00:00:00.000Z"),
          paymentStartDate: new Date("2026-05-01T00:00:00.000Z"),
          paymentEndDate: new Date("2026-05-15T00:00:00.000Z"),
        },
      ],
    });

    assert.equal(groups[0]!.cycleKey, "2026-07");
    assert.equal(groups[1]!.cycleKey, "2026-05");
  });
});

describe("cyclePhaseForExpenseGroup", () => {
  it("marks unpublished cycles as DRAFT", () => {
    assert.equal(
      cyclePhaseForExpenseGroup(
        {
          id: "c",
          cycleKey: "2026-07",
          title: "Jul",
          publishedAt: null,
          paymentStartDate: new Date("2026-08-01T00:00:00.000Z"),
          paymentEndDate: new Date("2026-08-15T00:00:00.000Z"),
        },
        new Date("2026-07-16T00:00:00.000Z"),
      ),
      "DRAFT",
    );
  });
});
