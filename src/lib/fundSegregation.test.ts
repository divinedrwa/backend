import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { computeFundSegregation } from "./fundSegregation.js";
import { invalidateMoneySnapshotCache } from "./societyFinance.js";

/**
 * Builds a fake PrismaClient that satisfies computeFundSegregation's queries.
 * The function delegates to getCachedMoneySnapshot internally, which reads
 * villaMaintenanceSnapshot, maintenancePayment, userCyclePayment,
 * maintenanceCollectionCycle, additionalFund (MERGE only), and expense.
 * On top of that, computeFundSegregation itself reads specialProject and
 * additionalFund (KEEP_SEPARATE).
 */
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
type MaintenanceCycle = {
  id: string;
  financialYearId: string;
  periodKey: string;
  periodMonth: number;
  periodYear: number;
};
type MergedFund = {
  amount: number;
  receivedDate: Date | null;
  month: number | null;
  year: number | null;
};
type Expense = {
  amount: number;
  paymentDate: Date | null;
  month: number | null;
  year: number | null;
};
type SpecialProject = {
  id: string;
  title: string;
  totalCollected: number;
  totalExpenses: number;
  targetAmount: number;
  status: string;
  societyId: string;
};
type SeparateFund = {
  id: string;
  title: string;
  amount: number;
  source: string | null;
  receivedDate: Date;
  destination: string;
  societyId: string;
};

function fakePrisma(opts: {
  snapshots?: Snapshot[];
  maintenancePayments?: MaintenancePayment[];
  maintenanceCycles?: MaintenanceCycle[];
  mergedFunds?: MergedFund[];
  expenses?: Expense[];
  projects?: SpecialProject[];
  separateFunds?: SeparateFund[];
}): PrismaClient {
  const {
    snapshots = [],
    maintenancePayments = [],
    maintenanceCycles = [],
    mergedFunds = [],
    expenses = [],
    projects = [],
    separateFunds = [],
  } = opts;

  return {
    villaMaintenanceSnapshot: { findMany: async () => snapshots },
    maintenancePayment: { findMany: async () => maintenancePayments },
    userCyclePayment: { findMany: async () => [] },
    maintenanceCollectionCycle: { findMany: async () => maintenanceCycles },
    additionalFund: {
      findMany: async (args: { where?: { destination?: string } }) => {
        const dest = args?.where?.destination;
        if (dest === "MERGE_WITH_MAINTENANCE") return mergedFunds;
        if (dest === "KEEP_SEPARATE") return separateFunds;
        return [];
      },
    },
    expense: { findMany: async () => expenses },
    specialProject: {
      findMany: async () => projects.filter((p) => p.status === "ACTIVE"),
    },
    financialYear: { findMany: async () => [] },
    monthlyExpenseSummary: { findMany: async () => [] },
  } as unknown as PrismaClient;
}

describe("computeFundSegregation", () => {
  it("returns all zeros when society has no financial data", async () => {
    const sid = "seg-test-empty";
    invalidateMoneySnapshotCache(sid);
    const db = fakePrisma({});
    const seg = await computeFundSegregation(db, sid);

    assert.equal(seg.maintenanceFund.balance, 0);
    assert.equal(seg.maintenanceFund.spendable, 0);
    assert.equal(seg.maintenanceFund.advanceCredit, 0);
    assert.equal(seg.projectFunds.total, 0);
    assert.equal(seg.separateFunds.total, 0);
    assert.equal(seg.computedBankBalance, 0);
    assert.equal(seg.outstandingDues, 0);
  });

  it("returns only maintenance fund when no projects or separate funds exist", async () => {
    const sid = "seg-test-maint-only";
    invalidateMoneySnapshotCache(sid);
    const db = fakePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 500, paidAmount: 500, status: "PAID" },
      ],
      maintenancePayments: [
        { villaId: "v1", maintenanceCollectionCycleId: "mc1", amount: 1000, paymentDate: new Date("2026-03-15"), month: 3, year: 2026 },
      ],
      maintenanceCycles: [
        { id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 },
      ],
    });
    const seg = await computeFundSegregation(db, sid);

    assert.equal(seg.maintenanceFund.balance, 1000);
    assert.equal(seg.maintenanceFund.advanceCredit, 500); // 1000 - 500
    assert.equal(seg.maintenanceFund.spendable, 500); // 1000 - 500
    assert.equal(seg.projectFunds.total, 0);
    assert.equal(seg.separateFunds.total, 0);
    assert.equal(seg.computedBankBalance, 1000);
  });

  it("sums maintenance + project + separate funds into computedBankBalance", async () => {
    const sid = "seg-test-mixed";
    invalidateMoneySnapshotCache(sid);
    const db = fakePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 500, paidAmount: 500, status: "PAID" },
      ],
      maintenancePayments: [
        { villaId: "v1", maintenanceCollectionCycleId: "mc1", amount: 500, paymentDate: new Date("2026-03-15"), month: 3, year: 2026 },
      ],
      maintenanceCycles: [
        { id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 },
      ],
      projects: [
        { id: "p1", title: "Lift Upgrade", totalCollected: 5000, totalExpenses: 2000, targetAmount: 10000, status: "ACTIVE", societyId: sid },
        { id: "p2", title: "Garden", totalCollected: 1000, totalExpenses: 300, targetAmount: 3000, status: "ACTIVE", societyId: sid },
      ],
      separateFunds: [
        { id: "sf1", title: "Corpus Fund", amount: 8000, source: "Donation", receivedDate: new Date("2026-01-10"), destination: "KEEP_SEPARATE", societyId: sid },
      ],
    });
    const seg = await computeFundSegregation(db, sid);

    // maintenance = 500 (cash) - 0 (expenses) = 500
    assert.equal(seg.maintenanceFund.balance, 500);
    // projects: (5000-2000) + (1000-300) = 3000 + 700 = 3700
    assert.equal(seg.projectFunds.total, 3700);
    assert.equal(seg.projectFunds.projects.length, 2);
    // separate: 8000
    assert.equal(seg.separateFunds.total, 8000);
    assert.equal(seg.separateFunds.items.length, 1);
    // bank total: 500 + 3700 + 8000 = 12200
    assert.equal(seg.computedBankBalance, 12200);
  });

  it("computes spendable as maintenance balance minus advance credit", async () => {
    const sid = "seg-test-spendable";
    invalidateMoneySnapshotCache(sid);
    const db = fakePrisma({
      snapshots: [
        { villaId: "v1", cycleId: "mc1", expectedAmount: 300, paidAmount: 300, status: "PAID" },
      ],
      maintenancePayments: [
        { villaId: "v1", maintenanceCollectionCycleId: "mc1", amount: 1000, paymentDate: new Date("2026-03-15"), month: 3, year: 2026 },
      ],
      maintenanceCycles: [
        { id: "mc1", financialYearId: "fy1", periodKey: "2026-03", periodMonth: 3, periodYear: 2026 },
      ],
      mergedFunds: [
        { amount: 200, receivedDate: new Date("2026-03-20"), month: 3, year: 2026 },
      ],
      expenses: [
        { amount: 400, paymentDate: new Date("2026-03-22"), month: 3, year: 2026 },
      ],
    });
    const seg = await computeFundSegregation(db, sid);

    // balance = 1000 + 200 - 400 = 800
    assert.equal(seg.maintenanceFund.balance, 800);
    // advance credit = 1000 cash - 300 expected = 700
    assert.equal(seg.maintenanceFund.advanceCredit, 700);
    // spendable = 800 - 700 = 100
    assert.equal(seg.maintenanceFund.spendable, 100);
    assert.equal(seg.maintenanceFund.cashInflow, 1000);
    assert.equal(seg.maintenanceFund.additionalMergedInflow, 200);
    assert.equal(seg.maintenanceFund.totalExpenses, 400);
  });
});
