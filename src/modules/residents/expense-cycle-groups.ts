import { BillingCycleStatus, Prisma } from "@prisma/client";
import { deriveCycleStatusUtc } from "../billing-cycle/domain/cycleStatus";

export type ExpenseCyclePhase = "DRAFT" | "UPCOMING" | "OPEN" | "CLOSED" | "NO_CYCLE";

export type ExpenseRowForGrouping = {
  id: string;
  title: string;
  amount: Prisma.Decimal;
  netAmount: Prisma.Decimal;
  paymentDate: Date;
  paymentMode: string;
  paidTo: string;
  month: number | null;
  year: number | null;
  status: string;
  createdAt: Date;
  category: {
    id: string;
    name: string;
    icon: string | null;
    color: string | null;
    type: string;
  } | null;
  attachmentCount: number;
};

export type BillingCycleRowForGrouping = {
  id: string;
  cycleKey: string;
  title: string;
  publishedAt: Date | null;
  paymentStartDate: Date;
  paymentEndDate: Date;
};

export type ExpenseBillingCycleGroup = {
  groupKey: string;
  billingCycleId: string | null;
  cycleKey: string | null;
  title: string;
  phase: ExpenseCyclePhase;
  publishedAt: string | null;
  paymentStartDate: string | null;
  paymentEndDate: string | null;
  month: number;
  year: number;
  totalAmount: number;
  expenseCount: number;
  expenses: ExpenseRowForGrouping[];
};

export function expensePeriodKey(expense: Pick<ExpenseRowForGrouping, "month" | "year" | "paymentDate">): string {
  let month = expense.month;
  let year = expense.year;
  if (month == null || year == null) {
    const d = expense.paymentDate;
    month = d.getUTCMonth() + 1;
    year = d.getUTCFullYear();
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function cyclePhaseForExpenseGroup(
  cycle: BillingCycleRowForGrouping | null,
  nowUtc: Date,
): ExpenseCyclePhase {
  if (!cycle) return "NO_CYCLE";
  if (!cycle.publishedAt) return "DRAFT";
  const status = deriveCycleStatusUtc(nowUtc, cycle.paymentStartDate, cycle.paymentEndDate);
  if (status === BillingCycleStatus.UPCOMING) return "UPCOMING";
  if (status === BillingCycleStatus.OPEN) return "OPEN";
  return "CLOSED";
}

export function groupTitleForCycle(
  cycleKey: string,
  cycle: BillingCycleRowForGrouping | null,
): string {
  if (cycle?.title?.trim()) return cycle.title.trim();
  const parts = cycleKey.split("-");
  if (parts.length >= 2) {
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) {
      const date = new Date(Date.UTC(y, m - 1, 1));
      return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    }
  }
  return cycleKey;
}

export function buildExpenseBillingCycleGroups(input: {
  expenses: ExpenseRowForGrouping[];
  cycles: BillingCycleRowForGrouping[];
  nowUtc?: Date;
  filterCycleKey?: string | null;
}): ExpenseBillingCycleGroup[] {
  const nowUtc = input.nowUtc ?? new Date();
  const cycleByKey = new Map(input.cycles.map((c) => [c.cycleKey, c]));
  const buckets = new Map<string, ExpenseRowForGrouping[]>();

  for (const expense of input.expenses) {
    const key = expensePeriodKey(expense);
    if (input.filterCycleKey && key !== input.filterCycleKey) continue;
    const list = buckets.get(key) ?? [];
    list.push(expense);
    buckets.set(key, list);
  }

  const groups: ExpenseBillingCycleGroup[] = [];
  for (const [cycleKey, items] of buckets) {
    const cycle = cycleByKey.get(cycleKey) ?? null;
    const [yearStr, monthStr] = cycleKey.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (!Number.isFinite(year) || !Number.isFinite(month)) continue;

    items.sort((a, b) => b.paymentDate.getTime() - a.paymentDate.getTime());
    const totalAmount = items.reduce((sum, e) => sum + Number(e.amount), 0);

    groups.push({
      groupKey: cycleKey,
      billingCycleId: cycle?.id ?? null,
      cycleKey,
      title: groupTitleForCycle(cycleKey, cycle),
      phase: cyclePhaseForExpenseGroup(cycle, nowUtc),
      publishedAt: cycle?.publishedAt?.toISOString() ?? null,
      paymentStartDate: cycle?.paymentStartDate.toISOString() ?? null,
      paymentEndDate: cycle?.paymentEndDate.toISOString() ?? null,
      month,
      year,
      totalAmount,
      expenseCount: items.length,
      expenses: items,
    });
  }

  groups.sort((a, b) => b.cycleKey!.localeCompare(a.cycleKey!));
  return groups;
}
