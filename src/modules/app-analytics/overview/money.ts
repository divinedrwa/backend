import { BillingUserPaymentStatus, ExpenseStatus, PaymentMode } from "@prisma/client";
import { getCachedMoneySnapshot } from "../../../lib/societyFinance";
import { computeOutstandingDues } from "../../maintenance-management/outstandingDues";
import {
  type Change,
  type Contact,
  type Db,
  type Period,
  countChange,
  formatRupees,
  pct,
  plural,
  toneFor,
  type Tone,
} from "./common";

const MODE_LABELS: Record<PaymentMode, string> = {
  CASH: "Cash",
  UPI: "UPI",
  BANK_TRANSFER: "Bank transfer",
  CHEQUE: "Cheque",
  ONLINE: "Online (app)",
  PHONEPE: "Online (PhonePe)",
};
export const ONLINE_MODES: PaymentMode[] = [PaymentMode.ONLINE, PaymentMode.PHONEPE];

export type MoneySection = {
  collectionRatePct: number;
  collected: string;
  expected: string;
  collectionTone: Tone;
  fundBalance: string;
  fundBalanceValue: number;
  /** Months the fund covers at the last 3 months' average spend; null when there's no spend. */
  monthsOfCover: number | null;
  pending: {
    amount: string;
    amountValue: number;
    flats: number;
    /** Flats owing for two or more billing cycles. */
    chronicFlats: number;
    top: (Contact & { amount: string; cycles: number })[];
  };
  received: {
    amount: string;
    amountValue: number;
    payments: number;
    flats: number;
    onlineFlats: number;
    onlinePct: number;
    change: Change;
    byMode: { label: string; amount: string; value: number; pct: number }[];
  };
  otherIncome: string;
  expenses: {
    amount: string;
    amountValue: number;
    change: Change;
    top: { label: string; amount: string; value: number; pct: number }[];
  };
  /** Money in (maintenance + other income) minus money out, for the period. */
  net: string;
  netValue: number;
  onlinePayments: {
    /** Online payments that failed at the gateway. */
    failed: number;
    /** Started more than an hour ago and never finished. */
    abandoned: number;
  };
};

async function paymentsIn(db: Db, societyId: string, from: Date, to: Date) {
  const rows = await db.maintenancePayment.findMany({
    where: {
      societyId,
      paymentDate: { gte: from, lt: to },
      reversedAt: null,
      reversalOfPaymentId: null,
    },
    select: { amount: true, villaId: true, paymentMode: true },
  });
  return rows.map((r) => ({ amount: Number(r.amount), villaId: r.villaId, mode: r.paymentMode }));
}

async function expensesIn(db: Db, societyId: string, from: Date, to: Date) {
  const rows = await db.expense.findMany({
    where: {
      societyId,
      status: ExpenseStatus.APPROVED,
      deletedAt: null,
      paymentDate: { gte: from, lt: to },
    },
    select: { amount: true, category: { select: { name: true } } },
  });
  return rows.map((r) => ({ amount: Number(r.amount), category: r.category?.name ?? "Other" }));
}

/** Calendar month/year `back` months before `now`. */
function monthBack(now: Date, back: number) {
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}

export async function buildMoney(db: Db, societyId: string, p: Period): Promise<MoneySection> {
  const [snapshot, dues, received, prevReceived, expenses, prevExpenses, otherIncome, failed, abandoned] =
    await Promise.all([
      getCachedMoneySnapshot(db, societyId),
      computeOutstandingDues(db, societyId),
      paymentsIn(db, societyId, p.from, p.now),
      paymentsIn(db, societyId, p.prevFrom, p.from),
      expensesIn(db, societyId, p.from, p.now),
      expensesIn(db, societyId, p.prevFrom, p.from),
      db.additionalFund.aggregate({
        where: { societyId, receivedDate: { gte: p.from, lt: p.now } },
        _sum: { amount: true },
      }),
      db.userCyclePayment.count({
        where: {
          cycle: { societyId },
          paymentStatus: BillingUserPaymentStatus.FAILED,
          createdAt: { gte: p.from },
        },
      }),
      db.userCyclePayment.count({
        where: {
          cycle: { societyId },
          paymentStatus: BillingUserPaymentStatus.PENDING,
          createdAt: { gte: p.from, lt: new Date(p.now.getTime() - 60 * 60 * 1000) },
        },
      }),
    ]);

  // Same definitions as the Society Finances card.
  const expected = snapshot.expectedAllTime;
  const collectedForRate = expected - snapshot.outstandingDues;
  const rate = expected > 0 ? Math.min(100, Math.round((collectedForRate / expected) * 1000) / 10) : 0;

  const lastThree = [1, 2, 3].map((b) => monthBack(p.now, b));
  const avgSpend = lastThree.reduce((s, m) => s + snapshot.expensesForMonth(m.month, m.year), 0) / 3;
  const balance = snapshot.currentFundBalance;
  const monthsOfCover = avgSpend > 0 ? Math.round((balance / avgSpend) * 10) / 10 : null;

  // Contact for each owing flat: owner phone, else an active resident's phone.
  const villaIds = dues.villas.slice(0, 50).map((v) => v.villaId);
  const villas = villaIds.length
    ? await db.villa.findMany({
        where: { id: { in: villaIds } },
        select: {
          id: true,
          villaNumber: true,
          block: true,
          ownerName: true,
          ownerPhone: true,
          users: { where: { isActive: true, phone: { not: null } }, select: { phone: true }, take: 1 },
        },
      })
    : [];
  const villaById = new Map(villas.map((v) => [v.id, v]));

  const receivedTotal = received.reduce((s, r) => s + r.amount, 0);
  const prevReceivedTotal = prevReceived.reduce((s, r) => s + r.amount, 0);
  const payingFlats = new Set(received.map((r) => r.villaId));
  const onlineFlats = new Set(received.filter((r) => ONLINE_MODES.includes(r.mode)).map((r) => r.villaId));

  const byModeMap = new Map<string, number>();
  for (const r of received) byModeMap.set(MODE_LABELS[r.mode], (byModeMap.get(MODE_LABELS[r.mode]) ?? 0) + r.amount);
  const byMode = [...byModeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value, amount: formatRupees(value), pct: pct(value, receivedTotal) }));

  const spent = expenses.reduce((s, e) => s + e.amount, 0);
  const prevSpent = prevExpenses.reduce((s, e) => s + e.amount, 0);
  const byCategory = new Map<string, number>();
  for (const e of expenses) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount);
  const topExpenses = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, value]) => ({ label, value, amount: formatRupees(value), pct: pct(value, spent) }));

  const other = Number(otherIncome._sum.amount ?? 0);
  const net = receivedTotal + other - spent;

  return {
    collectionRatePct: rate,
    collected: formatRupees(collectedForRate),
    expected: formatRupees(expected),
    collectionTone: toneFor(rate, 90, 75),
    fundBalance: formatRupees(balance),
    fundBalanceValue: balance,
    monthsOfCover,
    pending: {
      amount: formatRupees(dues.totalOutstanding),
      amountValue: dues.totalOutstanding,
      flats: dues.villasWithDuesCount,
      chronicFlats: dues.villas.filter((v) => v.pendingCycles.length >= 2).length,
      top: dues.villas.slice(0, 50).map((v) => {
        const villa = villaById.get(v.villaId);
        return {
          name: v.ownerName || villa?.ownerName || "Owner",
          flat: villa ? (villa.block?.trim() ? `${villa.block.trim()}-${villa.villaNumber}` : villa.villaNumber) : v.villaNumber,
          phone: villa?.ownerPhone ?? villa?.users[0]?.phone ?? null,
          amount: formatRupees(v.totalOutstanding),
          cycles: v.pendingCycles.length,
          detail: plural(v.pendingCycles.length, "month"),
        };
      }),
    },
    received: {
      amount: formatRupees(receivedTotal),
      amountValue: receivedTotal,
      payments: received.length,
      flats: payingFlats.size,
      onlineFlats: onlineFlats.size,
      onlinePct: pct(onlineFlats.size, payingFlats.size),
      change: countChange(Math.round(receivedTotal), Math.round(prevReceivedTotal)),
      byMode,
    },
    otherIncome: formatRupees(other),
    expenses: {
      amount: formatRupees(spent),
      amountValue: spent,
      change: countChange(Math.round(spent), Math.round(prevSpent), false),
      top: topExpenses,
    },
    net: formatRupees(net),
    netValue: net,
    onlinePayments: { failed, abandoned },
  };
}
