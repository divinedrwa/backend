/**
 * Unit tests for [computeSocietyMoneySnapshot]. Exercises the per-(villa,
 * cycle) reconciliation logic that decides which ledger wins when the
 * cash- and user-side ledgers disagree, plus the calendar-month and
 * advance-credit derivations.
 *
 * Each test constructs an in-memory fake of the Prisma client narrow
 * enough to satisfy the queries the function actually makes — anything
 * the real client supports but we don't use here is intentionally absent
 * so the type assertion fails loudly if the implementation grows new
 * dependencies.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { computeSocietyMoneySnapshot } from "./societyFinance.js";

type Snapshot = {
  villaId: string;
  cycleId: string;
  expectedAmount: number;
  paidAmount: number;
  status: "PENDING" | "PAID" | "PARTIAL" | "OVERDUE" | "WAIVED";
};
type MaintenancePayment = {
  villaId: string;
  maintenanceCollectionCycleId: string | null;
  amount: number;
  paymentDate: Date;
  month: number;
  year: number;
};
type UserCyclePayment = {
  cycle: { id: string; financialYearId: string; cycleKey: string };
  user: { villaId: string };
  amountPaid: number;
  paidAt: Date | null;
};
type MaintenanceCycle = { id: string; financialYearId: string; periodKey: string; periodMonth: number; periodYear: number };
type AdditionalFund = { amount: number; receivedDate: Date | null; month: number | null; year: number | null };
type Expense = {
  amount: number;
  paymentDate: Date | null;
  month: number | null;
  year: number | null;
  deletedAt?: Date | null;
};

function fakePrisma(opts: {
  snapshots?: Snapshot[];
  maintenancePayments?: MaintenancePayment[];
  userCyclePayments?: UserCyclePayment[];
  maintenanceCycles?: MaintenanceCycle[];
  additionalFunds?: AdditionalFund[];
  expenses?: Expense[];
}): PrismaClient {
  const {
    snapshots = [],
    maintenancePayments = [],
    userCyclePayments = [],
    maintenanceCycles = [],
    additionalFunds = [],
    expenses = [],
  } = opts;
  // Minimal groupBy fake for the credit walker's two aggregate shapes:
  // by villa+cycle (linked cash) and by villa+month+year (unlinked rows).
  const groupBy = async (args: { by: string[]; where?: Record<string, unknown> }) => {
    const where = args.where ?? {};
    const mcFilter = Object.prototype.hasOwnProperty.call(where, "maintenanceCollectionCycleId")
      ? (where.maintenanceCollectionCycleId as { in?: string[] } | null)
      : undefined;
    const rows = maintenancePayments.filter((mp) => {
      if (mcFilter === undefined) return true;
      if (mcFilter === null) return mp.maintenanceCollectionCycleId === null;
      if (Array.isArray(mcFilter.in)) {
        return (
          mp.maintenanceCollectionCycleId !== null &&
          mcFilter.in.includes(mp.maintenanceCollectionCycleId)
        );
      }
      return true;
    });
    const groups = new Map<string, { key: Record<string, unknown>; sum: number }>();
    for (const mp of rows) {
      const rec = mp as unknown as Record<string, unknown>;
      const key = args.by.map((f) => String(rec[f])).join("|");
      const g = groups.get(key) ?? {
        key: Object.fromEntries(args.by.map((f) => [f, rec[f]])),
        sum: 0,
      };
      g.sum += mp.amount;
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => ({ ...g.key, _sum: { amount: g.sum } }));
  };

  return {
    villaMaintenanceSnapshot: { findMany: async () => snapshots },
    maintenancePayment: { findMany: async () => maintenancePayments, groupBy },
    userCyclePayment: { findMany: async () => userCyclePayments },
    maintenanceCollectionCycle: { findMany: async () => maintenanceCycles },
    additionalFund: { findMany: async () => additionalFunds },
    expense: {
      findMany: async (args?: { where?: { deletedAt?: null } }) => {
        let rows = expenses;
        if (args?.where?.deletedAt === null) {
          rows = rows.filter((e) => !e.deletedAt);
        }
        return rows;
      },
    },
    // Credit walker's billing context — no billing cycles in these scenarios.
    billingCycle: { findMany: async () => [] },
  } as unknown as PrismaClient;
}

describe("computeSocietyMoneySnapshot", () => {
  it("falls back to MaintenancePayment when only the cash ledger is populated", async () => {
    const db = fakePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 370, paidAmount: 370, status: "PAID" },
      ],
      maintenancePayments: [
        { villaId: "v1", maintenanceCollectionCycleId: "mc1", amount: 1300, paymentDate: new Date("2026-03-15"), month: 3, year: 2026 },
      ],
      maintenanceCycles: [{ id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 }],
    });
    const m = await computeSocietyMoneySnapshot(db, "s1");
    // Cash truth = the bigger ledger (1300); user ledger absent here.
    assert.equal(m.maintenanceCashAllTime, 1300);
    assert.equal(m.maintenanceCashForCycle("mc1"), 1300);
    assert.equal(m.totalAdvanceCredit, 930); // 1300 paid − 370 expected
  });

  it("recovers historical capping by reading UserCyclePayment when MP was capped", async () => {
    // The exact bug pattern: pre-fix mark-cash wrote MP capped at expected,
    // but UCP got the full amount. The snapshot must surface the full cash
    // for maintenanceCashAllTime, but totalAdvanceCredit uses MP only
    // (matching the credit-walker) to avoid UCP inflation from credit sync.
    const db = fakePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 370, paidAmount: 370, status: "PAID" },
      ],
      maintenancePayments: [
        { villaId: "v1", maintenanceCollectionCycleId: "mc1", amount: 370, paymentDate: new Date("2026-03-15"), month: 3, year: 2026 },
      ],
      userCyclePayments: [
        {
          cycle: { id: "bc1", financialYearId: "fy1", cycleKey: "2026-03" },
          user: { villaId: "v1" },
          amountPaid: 1300,
          paidAt: new Date("2026-03-15"),
        },
      ],
      maintenanceCycles: [{ id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 }],
    });
    const m = await computeSocietyMoneySnapshot(db, "s1");
    // Cash uses reconciled max(MP, UCP) = 1300
    assert.equal(m.maintenanceCashAllTime, 1300);
    // Advance credit uses MP-only: 370 cash − 370 expected = 0
    assert.equal(m.totalAdvanceCredit, 0);
  });

  it("does not double-count when the same cash hits two PRIMARY residents' UCP rows", async () => {
    // mark-paid writes UserCyclePayment for every PRIMARY resident with
    // the same amount. We must read MAX (not SUM) so the cash isn't
    // multiplied by the number of residents.
    const db = fakePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 370, paidAmount: 370, status: "PAID" },
      ],
      maintenancePayments: [
        { villaId: "v1", maintenanceCollectionCycleId: "mc1", amount: 1300, paymentDate: new Date("2026-03-15"), month: 3, year: 2026 },
      ],
      userCyclePayments: [
        // Two primary residents, same villa, same amount mirrored.
        {
          cycle: { id: "bc1", financialYearId: "fy1", cycleKey: "2026-03" },
          user: { villaId: "v1" },
          amountPaid: 1300,
          paidAt: new Date("2026-03-15"),
        },
        {
          cycle: { id: "bc1", financialYearId: "fy1", cycleKey: "2026-03" },
          user: { villaId: "v1" },
          amountPaid: 1300,
          paidAt: new Date("2026-03-15"),
        },
      ],
      maintenanceCycles: [{ id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 }],
    });
    const m = await computeSocietyMoneySnapshot(db, "s1");
    assert.equal(m.maintenanceCashAllTime, 1300);
    assert.equal(m.totalAdvanceCredit, 930);
  });

  it("includes non-cycle MaintenancePayment rows in the cash totals", async () => {
    // The legacy mark-paid path can create MP rows without
    // maintenanceCollectionCycleId. Those still represent cash that hit
    // the bank — they belong in the fund balance.
    const db = fakePrisma({
      maintenancePayments: [
        { villaId: "v1", maintenanceCollectionCycleId: null, amount: 500, paymentDate: new Date("2026-03-10"), month: 3, year: 2026 },
        { villaId: "v1", maintenanceCollectionCycleId: "mc1", amount: 370, paymentDate: new Date("2026-03-15"), month: 3, year: 2026 },
      ],
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 370, paidAmount: 370, status: "PAID" },
      ],
      maintenanceCycles: [{ id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 }],
    });
    const m = await computeSocietyMoneySnapshot(db, "s1");
    assert.equal(m.maintenanceCashAllTime, 870);
    assert.equal(m.maintenanceCashForMonth(3, 2026), 870);
  });

  it("computes currentFundBalance as cash − expenses, including additional funds", async () => {
    const db = fakePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 370, paidAmount: 370, status: "PAID" },
      ],
      maintenancePayments: [
        { villaId: "v1", maintenanceCollectionCycleId: "mc1", amount: 1300, paymentDate: new Date("2026-03-15"), month: 3, year: 2026 },
      ],
      maintenanceCycles: [{ id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 }],
      additionalFunds: [
        { amount: 200, receivedDate: new Date("2026-03-20"), month: 3, year: 2026 },
      ],
      expenses: [
        { amount: 800, paymentDate: new Date("2026-03-22"), month: 3, year: 2026 },
      ],
    });
    const m = await computeSocietyMoneySnapshot(db, "s1");
    assert.equal(m.maintenanceCashAllTime, 1300);
    assert.equal(m.additionalFundsAllTime, 200);
    assert.equal(m.expensesAllTime, 800);
    assert.equal(m.currentFundBalance, 700); // 1300 + 200 − 800
  });

  it("treats WAIVED cycles as fully covered for cycle-progress without consuming cash", async () => {
    const db = fakePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 370, paidAmount: 0, status: "WAIVED" },
      ],
      maintenancePayments: [],
      maintenanceCycles: [{ id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 }],
    });
    const m = await computeSocietyMoneySnapshot(db, "s1");
    // Cycle counts as paid for progress, but no cash was received.
    assert.equal(m.cycleProgressCollectedForCycle("mc1"), 370);
    assert.equal(m.maintenanceCashAllTime, 0);
    assert.equal(m.totalAdvanceCredit, 0);
  });

  it("does not double-count when advance credit is applied to a cycle", async () => {
    // Villa A overpaid ₹1300 for cycle 1 (expected ₹370). Admin applied
    // ₹370 credit to cycle 2. The apply-credit endpoint creates a ₹0
    // audit-marker MP and syncs UCP with snapshot.paidAmount (₹370).
    // maintenanceCashAllTime must stay at ₹1300 (real cash), not ₹1670.
    const db = fakePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 370, paidAmount: 370, status: "PAID" },
        { villaId: "v1", cycleId: "mc2", expectedAmount: 370, paidAmount: 370, status: "PAID" },
      ],
      maintenancePayments: [
        { villaId: "v1", maintenanceCollectionCycleId: "mc1", amount: 1300, paymentDate: new Date("2026-03-15"), month: 3, year: 2026 },
        // ₹0 audit marker from apply-credit
        { villaId: "v1", maintenanceCollectionCycleId: "mc2", amount: 0, paymentDate: new Date("2026-04-01"), month: 4, year: 2026 },
      ],
      userCyclePayments: [
        {
          cycle: { id: "bc1", financialYearId: "fy1", cycleKey: "2026-03" },
          user: { villaId: "v1" },
          amountPaid: 1300,
          paidAt: new Date("2026-03-15"),
        },
        // UCP synced from credit application — NOT new cash
        {
          cycle: { id: "bc2", financialYearId: "fy1", cycleKey: "2026-04" },
          user: { villaId: "v1" },
          amountPaid: 370,
          paidAt: new Date("2026-04-01"),
        },
      ],
      maintenanceCycles: [
        { id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 },
        { id: "mc2", financialYearId: "fy1", periodKey: "2026-04", periodMonth: 4, periodYear: 2026 },
      ],
    });
    const m = await computeSocietyMoneySnapshot(db, "s1");
    // Only ₹1300 of real cash entered the society, not ₹1670.
    assert.equal(m.maintenanceCashAllTime, 1300);
    assert.equal(m.currentFundBalance, 1300);
    // Advance credit: ₹1300 paid − ₹740 expected = ₹560 remaining
    assert.equal(m.totalAdvanceCredit, 560);
  });

  it("does not double-count when manual credit adjustment is applied", async () => {
    // Admin adds ₹500 manual credit (unlinked MP). Credit walker applies
    // ₹370 to pending cycle. UCP synced with paidAmount ₹370.
    // maintenanceCashAllTime must stay at ₹500, not ₹870.
    const db = fakePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 370, paidAmount: 370, status: "PAID" },
      ],
      maintenancePayments: [
        // Unlinked manual credit adjustment
        { villaId: "v1", maintenanceCollectionCycleId: null, amount: 500, paymentDate: new Date("2026-03-10"), month: 3, year: 2026 },
      ],
      userCyclePayments: [
        // UCP synced from credit applied to cycle — NOT new cash
        {
          cycle: { id: "bc1", financialYearId: "fy1", cycleKey: "2026-03" },
          user: { villaId: "v1" },
          amountPaid: 370,
          paidAt: new Date("2026-03-10"),
        },
      ],
      maintenanceCycles: [{ id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 }],
    });
    const m = await computeSocietyMoneySnapshot(db, "s1");
    // Only ₹500 of real cash, not ₹870 (500 unlinked + 370 UCP).
    assert.equal(m.maintenanceCashAllTime, 500);
    assert.equal(m.currentFundBalance, 500);
    // Advance credit: ₹500 total cash − ₹370 expected = ₹130 remaining
    assert.equal(m.totalAdvanceCredit, 130);
  });

  it("buckets cash by paymentDate so calendar-month flow is correct", async () => {
    const db = fakePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 370, paidAmount: 370, status: "PAID" },
        { villaId: "v1", cycleId: "mc2", expectedAmount: 370, paidAmount: 370, status: "PAID" },
      ],
      maintenancePayments: [
        { villaId: "v1", maintenanceCollectionCycleId: "mc1", amount: 1300, paymentDate: new Date(Date.UTC(2026, 2, 15)), month: 3, year: 2026 },
        { villaId: "v1", maintenanceCollectionCycleId: "mc2", amount: 370, paymentDate: new Date(Date.UTC(2026, 3, 5)), month: 4, year: 2026 },
      ],
      maintenanceCycles: [
        { id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 },
        { id: "mc2", financialYearId: "fy1", periodKey: "2026-04", periodMonth: 4, periodYear: 2026 },
      ],
    });
    const m = await computeSocietyMoneySnapshot(db, "s1");
    assert.equal(m.maintenanceCashForMonth(3, 2026), 1300);
    assert.equal(m.maintenanceCashForMonth(4, 2026), 370);
    assert.equal(m.maintenanceCashAllTime, 1670);
  });

  it("excludes soft-deleted expenses from fund balance", async () => {
    const db = fakePrisma({
      expenses: [
        {
          amount: 500,
          paymentDate: new Date("2026-07-01"),
          month: 7,
          year: 2026,
        },
        {
          amount: 300,
          paymentDate: new Date("2026-07-02"),
          month: 7,
          year: 2026,
          deletedAt: new Date("2026-07-03"),
        },
      ],
    });
    const m = await computeSocietyMoneySnapshot(db, "s1");
    assert.equal(m.expensesAllTime, 500);
    assert.equal(m.currentFundBalance, -500);
  });

  it("does not zero society advance credit when future billing snapshots exist", async () => {
    const now = new Date();
    const cy = now.getFullYear();
    const cm = now.getMonth() + 1;
    const prevMonth = cm === 1 ? 12 : cm - 1;
    const prevYear = cm === 1 ? cy - 1 : cy;
    const nextMonth = cm === 12 ? 1 : cm + 1;
    const nextYear = cm === 12 ? cy + 1 : cy;
    const pkPrev = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
    const pkCur = `${cy}-${String(cm).padStart(2, "0")}`;
    const pkNext = `${nextYear}-${String(nextMonth).padStart(2, "0")}`;

    const db = fakePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc-prev", expectedAmount: 1100, paidAmount: 1100, status: "PAID" },
        { villaId: "v1", cycleId: "mc-cur", expectedAmount: 1100, paidAmount: 0, status: "PENDING" },
        { villaId: "v1", cycleId: "mc-next", expectedAmount: 1100, paidAmount: 0, status: "PENDING" },
      ],
      maintenancePayments: [
        {
          villaId: "v1",
          maintenanceCollectionCycleId: "mc-prev",
          amount: 1300,
          paymentDate: new Date(prevYear, prevMonth - 1, 15),
          month: prevMonth,
          year: prevYear,
        },
      ],
      maintenanceCycles: [
        { id: "mc-prev", financialYearId: "fy1", periodKey: pkPrev, periodMonth: prevMonth, periodYear: prevYear },
        { id: "mc-cur", financialYearId: "fy1", periodKey: pkCur, periodMonth: cm, periodYear: cy },
        { id: "mc-next", financialYearId: "fy1", periodKey: pkNext, periodMonth: nextMonth, periodYear: nextYear },
      ],
    });
    const m = await computeSocietyMoneySnapshot(db, "s1");
    assert.equal(m.totalAdvanceCredit, 200);
  });
});
