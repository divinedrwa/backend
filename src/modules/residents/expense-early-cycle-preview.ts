import { PrismaClient } from "@prisma/client";
import {
  BillingCycleRowForGrouping,
  cyclePhaseForExpenseGroup,
  groupTitleForCycle,
} from "./expense-cycle-groups";

export type EarlyCycleExpensePreview = {
  billingCycleId: string | null;
  cycleKey: string;
  title: string;
  phase: "DRAFT" | "UPCOMING";
  month: number;
  year: number;
  totalAmount: number;
  expenseCount: number;
  paymentStartDate: string | null;
};

export function pickEarlyCycleExpensePreview(input: {
  cycles: BillingCycleRowForGrouping[];
  expenseTotalsByCycleKey: Map<string, { expenseCount: number; totalAmount: number }>;
  nowUtc?: Date;
}): EarlyCycleExpensePreview | null {
  const nowUtc = input.nowUtc ?? new Date();
  const candidates: EarlyCycleExpensePreview[] = [];

  for (const cycle of input.cycles) {
    const totals = input.expenseTotalsByCycleKey.get(cycle.cycleKey);
    if (!totals || totals.expenseCount <= 0) continue;

    const phase = cyclePhaseForExpenseGroup(cycle, nowUtc);
    if (phase !== "DRAFT" && phase !== "UPCOMING") continue;

    candidates.push({
      billingCycleId: cycle.id,
      cycleKey: cycle.cycleKey,
      title: groupTitleForCycle(cycle.cycleKey, cycle),
      phase,
      month: Number(cycle.cycleKey.split("-")[1]),
      year: Number(cycle.cycleKey.split("-")[0]),
      totalAmount: totals.totalAmount,
      expenseCount: totals.expenseCount,
      paymentStartDate: cycle.paymentStartDate.toISOString(),
    });
  }

  candidates.sort((a, b) => b.cycleKey.localeCompare(a.cycleKey));
  return candidates[0] ?? null;
}

export async function loadEarlyCycleExpensesPreview(
  db: Pick<PrismaClient, "billingCycle" | "expense">,
  societyId: string,
  nowUtc = new Date(),
): Promise<EarlyCycleExpensePreview | null> {
  const [cycles, expenseAgg] = await Promise.all([
    db.billingCycle.findMany({
      where: { societyId },
      select: {
        id: true,
        cycleKey: true,
        title: true,
        publishedAt: true,
        paymentStartDate: true,
        paymentEndDate: true,
      },
    }),
    db.expense.groupBy({
      by: ["month", "year"],
      where: {
        societyId,
        status: "APPROVED",
        deletedAt: null,
        month: { not: null },
        year: { not: null },
      },
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);

  const expenseTotalsByCycleKey = new Map<
    string,
    { expenseCount: number; totalAmount: number }
  >();
  for (const row of expenseAgg) {
    if (row.month == null || row.year == null) continue;
    const cycleKey = `${row.year}-${String(row.month).padStart(2, "0")}`;
    expenseTotalsByCycleKey.set(cycleKey, {
      expenseCount: row._count._all,
      totalAmount: Number(row._sum.amount ?? 0),
    });
  }

  return pickEarlyCycleExpensePreview({
    cycles,
    expenseTotalsByCycleKey,
    nowUtc,
  });
}
