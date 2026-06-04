import type { Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "./prisma";
import { getCachedMoneySnapshot } from "./societyFinance";

type Db = Prisma.TransactionClient | typeof defaultPrisma;

export interface CollectionCycleRow {
  cycleId: string;
  title: string;
  periodMonth: number;
  periodYear: number;
  status: string;
  totalExpected: number;
  totalCollected: number;
  totalExpense: number;
  net: number;
  paidCount: number;
  unpaidCount: number;
  collectionRate: number;
}

export interface CollectionSummary {
  expectedAllTime: number;
  collectedAllTime: number;
  collectionRate: number;
  cycles: CollectionCycleRow[];
}

export interface FundSegregation {
  maintenanceFund: {
    balance: number;
    spendable: number;
    advanceCredit: number;
    cashInflow: number;
    additionalMergedInflow: number;
    totalExpenses: number;
  };
  projectFunds: {
    total: number;
    projects: Array<{
      id: string;
      title: string;
      collected: number;
      spent: number;
      balance: number;
      target: number;
    }>;
  };
  separateFunds: {
    total: number;
    items: Array<{
      id: string;
      title: string;
      amount: number;
      source: string | null;
      receivedDate: Date;
    }>;
  };
  computedBankBalance: number;
  outstandingDues: number;
  collectionSummary: CollectionSummary;
}

export async function computeFundSegregation(
  db: Db,
  societyId: string,
): Promise<FundSegregation> {
  const money = await getCachedMoneySnapshot(db, societyId);

  const [projects, separateFunds, activeFYs] = await Promise.all([
    db.specialProject.findMany({
      where: { societyId, status: "ACTIVE" },
      select: { id: true, title: true, totalCollected: true, totalExpenses: true, targetAmount: true },
    }),
    db.additionalFund.findMany({
      where: { societyId, destination: "KEEP_SEPARATE" },
      select: { id: true, title: true, amount: true, source: true, receivedDate: true },
    }),
    db.financialYear.findMany({
      where: { societyId, status: "ACTIVE" },
      select: { id: true },
    }),
  ]);

  // Per-cycle collection data (same pattern as shortfall endpoint)
  const fyIds = activeFYs.map((fy) => fy.id);
  const [cycles, expenseSummaries] = await Promise.all([
    fyIds.length > 0
      ? db.maintenanceCollectionCycle.findMany({
          where: { financialYearId: { in: fyIds } },
          orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
          select: {
            id: true,
            periodKey: true,
            periodMonth: true,
            periodYear: true,
            title: true,
            status: true,
            snapshots: {
              select: {
                expectedAmount: true,
                paidAmount: true,
                lateFeeAmount: true,
                status: true,
              },
            },
          },
        })
      : Promise.resolve([]),
    fyIds.length > 0
      ? db.monthlyExpenseSummary.findMany({
          where: { societyId },
          select: { month: true, year: true, totalExpenses: true },
        })
      : Promise.resolve([]),
  ]);

  const expenseByKey = new Map<string, number>();
  for (const s of expenseSummaries) {
    expenseByKey.set(`${s.year}-${String(s.month).padStart(2, "0")}`, Number(s.totalExpenses));
  }

  let expectedAllTime = 0;
  let collectedAllTime = 0;

  const cycleRows: CollectionCycleRow[] = cycles.map((c) => {
    const active = c.snapshots.filter((s) => s.status !== "WAIVED");
    const totalExpected = active.reduce(
      (sum, s) => sum + Number(s.expectedAmount) + Number(s.lateFeeAmount ?? 0),
      0,
    );
    const totalCollected = active.reduce((sum, s) => sum + Number(s.paidAmount), 0);
    const totalExpense = expenseByKey.get(c.periodKey) ?? 0;
    const net = totalCollected - totalExpense;
    const paidCount = active.filter((s) => s.status === "PAID").length;
    const unpaidCount = Math.max(0, active.length - paidCount);
    const collectionRate = totalExpected > 0 ? Math.round((totalCollected / totalExpected) * 10000) / 100 : 0;

    expectedAllTime += totalExpected;
    collectedAllTime += totalCollected;

    return {
      cycleId: c.id,
      title: c.title,
      periodMonth: c.periodMonth,
      periodYear: c.periodYear,
      status: c.status,
      totalExpected: Math.round(totalExpected * 100) / 100,
      totalCollected: Math.round(totalCollected * 100) / 100,
      totalExpense: Math.round(totalExpense * 100) / 100,
      net: Math.round(net * 100) / 100,
      paidCount,
      unpaidCount,
      collectionRate,
    };
  });

  expectedAllTime = Math.round(expectedAllTime * 100) / 100;
  collectedAllTime = Math.round(collectedAllTime * 100) / 100;
  const overallRate = expectedAllTime > 0 ? Math.round((collectedAllTime / expectedAllTime) * 10000) / 100 : 0;

  const collectionSummary: CollectionSummary = {
    expectedAllTime,
    collectedAllTime,
    collectionRate: overallRate,
    cycles: cycleRows,
  };

  const maintenanceFund = money.currentFundBalance;
  const advanceCredit = money.totalAdvanceCredit;
  const spendable = maintenanceFund - advanceCredit;

  const projectItems = projects.map((p) => ({
    id: p.id,
    title: p.title,
    collected: Number(p.totalCollected),
    spent: Number(p.totalExpenses),
    balance: Number(p.totalCollected) - Number(p.totalExpenses),
    target: Number(p.targetAmount),
  }));
  const projectFundsTotal = projectItems.reduce((s, p) => s + p.balance, 0);

  const separateItems = separateFunds.map((f) => ({
    id: f.id,
    title: f.title,
    amount: Number(f.amount),
    source: f.source,
    receivedDate: f.receivedDate,
  }));
  const separateFundsTotal = separateItems.reduce((s, f) => s + f.amount, 0);

  const computedBankBalance = maintenanceFund + projectFundsTotal + separateFundsTotal;

  return {
    maintenanceFund: {
      balance: maintenanceFund,
      spendable,
      advanceCredit,
      cashInflow: money.maintenanceCashAllTime,
      additionalMergedInflow: money.additionalFundsAllTime,
      totalExpenses: money.expensesAllTime,
    },
    projectFunds: {
      total: projectFundsTotal,
      projects: projectItems,
    },
    separateFunds: {
      total: separateFundsTotal,
      items: separateItems,
    },
    computedBankBalance,
    outstandingDues: money.outstandingDues,
    collectionSummary,
  };
}
