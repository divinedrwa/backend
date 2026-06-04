import type { Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "./prisma";
import { getCachedMoneySnapshot } from "./societyFinance";

type Db = Prisma.TransactionClient | typeof defaultPrisma;

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
}

export async function computeFundSegregation(
  db: Db,
  societyId: string,
): Promise<FundSegregation> {
  const money = await getCachedMoneySnapshot(db, societyId);

  const [projects, separateFunds] = await Promise.all([
    db.specialProject.findMany({
      where: { societyId, status: "ACTIVE" },
      select: { id: true, title: true, totalCollected: true, totalExpenses: true, targetAmount: true },
    }),
    db.additionalFund.findMany({
      where: { societyId, destination: "KEEP_SEPARATE" },
      select: { id: true, title: true, amount: true, source: true, receivedDate: true },
    }),
  ]);

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
  };
}
