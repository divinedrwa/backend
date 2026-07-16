import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pickEarlyCycleExpensePreview,
  type EarlyCycleExpensePreview,
} from "./expense-early-cycle-preview";

describe("pickEarlyCycleExpensePreview", () => {
  const draftCycle = {
    id: "c-jul",
    cycleKey: "2026-07",
    title: "July 2026 Maintenance",
    publishedAt: null,
    paymentStartDate: new Date("2026-08-01T00:00:00.000Z"),
    paymentEndDate: new Date("2026-08-15T00:00:00.000Z"),
  };

  const openCycle = {
    id: "c-jun",
    cycleKey: "2026-06",
    title: "June 2026 Maintenance",
    publishedAt: new Date("2026-06-01T00:00:00.000Z"),
    paymentStartDate: new Date("2026-06-01T00:00:00.000Z"),
    paymentEndDate: new Date("2026-06-15T00:00:00.000Z"),
  };

  it("returns null when draft cycle has no expenses", () => {
    const result = pickEarlyCycleExpensePreview({
      cycles: [draftCycle],
      expenseTotalsByCycleKey: new Map(),
      nowUtc: new Date("2026-07-16T00:00:00.000Z"),
    });
    assert.equal(result, null);
  });

  it("returns draft cycle preview when expenses exist", () => {
    const totals = new Map([
      ["2026-07", { expenseCount: 5, totalAmount: 12000 }],
    ]);
    const result = pickEarlyCycleExpensePreview({
      cycles: [draftCycle],
      expenseTotalsByCycleKey: totals,
      nowUtc: new Date("2026-07-16T00:00:00.000Z"),
    });
    assert.ok(result);
    assert.equal(result!.phase, "DRAFT");
    assert.equal(result!.expenseCount, 5);
    assert.equal(result!.totalAmount, 12000);
    assert.equal(result!.month, 7);
    assert.equal(result!.year, 2026);
  });

  it("skips open/closed cycles", () => {
    const totals = new Map([
      ["2026-06", { expenseCount: 3, totalAmount: 5000 }],
    ]);
    const result = pickEarlyCycleExpensePreview({
      cycles: [openCycle],
      expenseTotalsByCycleKey: totals,
      nowUtc: new Date("2026-06-10T00:00:00.000Z"),
    });
    assert.equal(result, null);
  });

  it("prefers the newest draft/upcoming cycle", () => {
    const upcomingCycle = {
      ...draftCycle,
      id: "c-aug",
      cycleKey: "2026-08",
      title: "August 2026",
      publishedAt: new Date("2026-07-01T00:00:00.000Z"),
      paymentStartDate: new Date("2026-09-01T00:00:00.000Z"),
      paymentEndDate: new Date("2026-09-15T00:00:00.000Z"),
    };
    const totals = new Map([
      ["2026-07", { expenseCount: 2, totalAmount: 1000 }],
      ["2026-08", { expenseCount: 1, totalAmount: 500 }],
    ]);
    const result = pickEarlyCycleExpensePreview({
      cycles: [draftCycle, upcomingCycle],
      expenseTotalsByCycleKey: totals,
      nowUtc: new Date("2026-07-16T00:00:00.000Z"),
    }) as EarlyCycleExpensePreview;
    assert.equal(result.cycleKey, "2026-08");
    assert.equal(result.phase, "UPCOMING");
  });
});
