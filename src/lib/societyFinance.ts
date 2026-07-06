import { Prisma } from "@prisma/client";
import { getVillaCreditBalancesBulk } from "../modules/maintenance-management/credit-walker";
import { prisma as defaultPrisma } from "./prisma";

type Db = Prisma.TransactionClient | typeof defaultPrisma;

// ── In-memory snapshot cache ────────────────────────────────────────
// The snapshot result contains closures, so Redis won't work. A short
// in-memory TTL (90s) is enough to collapse the 3+ dashboard endpoints
// that all call this function within the same page load into one DB hit.
const SNAPSHOT_CACHE_TTL_MS = 90_000;
type SnapshotCacheEntry = { expiresAt: number; snapshot: SocietyMoneySnapshot };
const snapshotCache = new Map<string, SnapshotCacheEntry>();

// Evict expired entries every 60s so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of snapshotCache) {
    if (now > entry.expiresAt) snapshotCache.delete(key);
  }
}, 60_000).unref();

/**
 * Cached wrapper around computeSocietyMoneySnapshot.
 * Use this from route handlers; use the raw function only in tests or
 * when you explicitly need a fresh read (e.g. inside a transaction).
 */
export async function getCachedMoneySnapshot(
  db: Db,
  societyId: string,
): Promise<SocietyMoneySnapshot> {
  const now = Date.now();
  const cached = snapshotCache.get(societyId);
  if (cached && now < cached.expiresAt) return cached.snapshot;

  const snapshot = await computeSocietyMoneySnapshot(db, societyId);
  snapshotCache.set(societyId, { expiresAt: now + SNAPSHOT_CACHE_TTL_MS, snapshot });
  return snapshot;
}

/** Evict the cached snapshot for a society (call after payments, expenses, etc.). */
export function invalidateMoneySnapshotCache(societyId: string): void {
  snapshotCache.delete(societyId);
}

/**
 * Canonical financial snapshot for a society.
 *
 * Every dashboard number that reads "money in / money out / balance" must
 * derive from this snapshot rather than aggregating a single table directly.
 * Two facts make a single-table aggregate unreliable on this codebase:
 *
 *   1. **Two cash ledgers, intentionally divergent.** `MaintenancePayment`
 *      records administrative cash entries; `UserCyclePayment.amountPaid`
 *      records the user-side acknowledged cash. They are independently
 *      writable (admin marks cash, gateway webhook updates user-side) and
 *      historical bugs let them drift apart. The cycle-service ledger
 *      treats `max(snapshotPaid, gatewayPaid)` as truth — this snapshot
 *      lifts the same logic from per-user to per-society scope so admin
 *      dashboards agree with what the resident sees on their bills page.
 *
 *   2. **Cycle-attributed vs calendar-cash double-meaning.** The same row
 *      has a `month/year` (cycle attribution) and a `paymentDate` (when
 *      cash actually arrived). Aggregating by the wrong axis gives the
 *      wrong answer for "money this month" vs "this cycle's collection".
 *
 * Use [computeSocietyMoneySnapshot] once per request, then read whichever
 * derived number the endpoint needs. The implementation runs five queries
 * in parallel; each helper on the snapshot is in-memory after that.
 */
export type SocietyMoneySnapshot = {
  societyId: string;

  /** Cumulative maintenance cash received across all time (canonical). */
  maintenanceCashAllTime: number;
  /** Maintenance cash received in a calendar month, by paymentDate. */
  maintenanceCashForMonth(month: number, year: number): number;
  /** Maintenance cash attributed to a single MaintenanceCollectionCycle. */
  maintenanceCashForCycle(maintenanceCollectionCycleId: string): number;

  /** Additional inflows that merge into the maintenance fund. */
  additionalFundsAllTime: number;
  additionalFundsForMonth(month: number, year: number): number;

  /** Society expenses (cash out). */
  expensesAllTime: number;
  expensesForMonth(month: number, year: number): number;

  /**
   * Pure-cash society fund balance. Equals
   *   (maintenance cash + additional funds) − expenses
   * so it agrees with the bank account regardless of which ledger
   * recorded a given payment.
   */
  currentFundBalance: number;

  /** Cycle-progress collected per maintenance cycle, capped at expected per villa. */
  cycleProgressCollectedForCycle(maintenanceCollectionCycleId: string): number;

  /** Total advance credit pool sitting on residents' ledgers (sum of villa overpayments). */
  totalAdvanceCredit: number;

  /** Sum of all expectedAmount across every (villa, cycle) snapshot — the total the society should have collected by now. */
  expectedAllTime: number;

  /**
   * Gross outstanding dues: sum of max(0, expected − paid) per (villa, cycle).
   * Unlike `expectedAllTime − maintenanceCashAllTime`, this does NOT net
   * overpayments (advance credit) against other villas' shortfalls — Villa A's
   * overpayment belongs to Villa A, not to the society's pending pool.
   */
  outstandingDues: number;
};

type CashRow = {
  villaId: string;
  cycleId: string; // MaintenanceCollectionCycle id
  cashReceived: number; // canonical: max(MP sum, max user-side amountPaid)
  expected: number;
  /** Most recent date this cycle's cash hit either ledger; used for monthly attribution. */
  recentPaymentDate: Date | null;
};

function ymKey(month: number, year: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function ymKeyFromDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function computeSocietyMoneySnapshot(
  db: Db,
  societyId: string,
): Promise<SocietyMoneySnapshot> {
  const [
    snapshots,
    maintenancePayments,
    userCyclePayments,
    additionalFunds,
    expenses,
  ] = await Promise.all([
    db.villaMaintenanceSnapshot.findMany({
      where: { cycle: { societyId } },
      select: {
        villaId: true,
        cycleId: true,
        expectedAmount: true,
        paidAmount: true,
        status: true,
      },
    }),
    db.maintenancePayment.findMany({
      where: { societyId },
      select: {
        villaId: true,
        maintenanceCollectionCycleId: true,
        amount: true,
        paymentDate: true,
        month: true,
        year: true,
      },
    }),
    /**
     * UserCyclePayment is keyed by `cycleId` = BillingCycle (not
     * MaintenanceCollectionCycle). Map between them via (financialYearId,
     * cycleKey/periodKey). Only PRIMARY residents pay; other roles can be
     * marked cash by the admin too — we collect all SUCCESS rows and let
     * the per-villa max smooth over the duplication when several primary
     * residents share a villa.
     */
    db.userCyclePayment.findMany({
      where: {
        paymentStatus: "SUCCESS",
        cycle: { societyId },
        user: { societyId },
      },
      select: {
        cycle: { select: { id: true, financialYearId: true, cycleKey: true } },
        user: { select: { villaId: true } },
        amountPaid: true,
        paidAt: true,
      },
    }),
    db.additionalFund.findMany({
      where: { societyId, destination: "MERGE_WITH_MAINTENANCE" },
      select: { amount: true, receivedDate: true, month: true, year: true },
    }),
    db.expense.findMany({
      where: { societyId, status: "APPROVED" },
      select: { amount: true, paymentDate: true, month: true, year: true },
    }),
  ]);

  const maintenanceCycles = await db.maintenanceCollectionCycle.findMany({
    where: { societyId },
    select: { id: true, financialYearId: true, periodKey: true, periodMonth: true, periodYear: true },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
  });
  const mcByFyKey = new Map<string, string>();
  for (const mc of maintenanceCycles) {
    mcByFyKey.set(`${mc.financialYearId}:${mc.periodKey}`, mc.id);
  }

  const expectedBySnap = new Map<string, number>();
  const snapByKey = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) {
    expectedBySnap.set(`${s.villaId}:${s.cycleId}`, Number(s.expectedAmount));
    snapByKey.set(`${s.villaId}:${s.cycleId}`, s);
  }

  // 1. Fold MaintenancePayment by (villa, MC cycle) — sums and most recent
  //    date. Payments without a `maintenanceCollectionCycleId` come from
  //    the legacy non-cycle mark-paid path; they don't fit the per-cycle
  //    reconciliation model but still represent real cash that hit the
  //    bank, so we tally them in `nonCycleCashAllTime` below.
  const mpByKey = new Map<string, { sum: number; latest: Date | null }>();
  let nonCycleCashAllTime = 0;
  const nonCycleCashByMonth = new Map<string, number>();
  for (const mp of maintenancePayments) {
    if (!mp.maintenanceCollectionCycleId) {
      const v = Number(mp.amount);
      nonCycleCashAllTime += v;
      const k = mp.paymentDate ? ymKeyFromDate(mp.paymentDate) : null;
      if (k) nonCycleCashByMonth.set(k, (nonCycleCashByMonth.get(k) ?? 0) + v);
      continue;
    }
    const key = `${mp.villaId}:${mp.maintenanceCollectionCycleId}`;
    const slot = mpByKey.get(key) ?? { sum: 0, latest: null };
    slot.sum += Number(mp.amount);
    if (!slot.latest || mp.paymentDate > slot.latest) slot.latest = mp.paymentDate;
    mpByKey.set(key, slot);
  }

  // 2. Fold UserCyclePayment by (villa, MC cycle) — MAX (not sum) because
  //    the same cash can be mirrored across multiple PRIMARY residents.
  //    The latest paidAt wins for monthly attribution.
  const ucpByKey = new Map<string, { max: number; latest: Date | null }>();
  for (const ucp of userCyclePayments) {
    const villaId = ucp.user?.villaId;
    if (!villaId) continue;
    const mcId = mcByFyKey.get(`${ucp.cycle.financialYearId}:${ucp.cycle.cycleKey}`);
    if (!mcId) continue;
    const key = `${villaId}:${mcId}`;
    const slot = ucpByKey.get(key) ?? { max: 0, latest: null };
    const amount = Number(ucp.amountPaid);
    if (amount > slot.max) {
      slot.max = amount;
      slot.latest = ucp.paidAt ?? slot.latest;
    } else if (amount === slot.max && ucp.paidAt && (!slot.latest || ucp.paidAt > slot.latest)) {
      slot.latest = ucp.paidAt;
    }
    ucpByKey.set(key, slot);
  }

  // 3. Reconcile: per (villa, cycle), canonical cash uses the MP ledger as
  //    primary and the UCP ledger as a correction for historical-capping
  //    bugs only.  When the MP sum is meaningful (> 0), we take
  //    max(mpSum, ucpMax) to recover capped rows from the old mark-cash
  //    code path.  When the MP sum is ≈ 0, the UCP amount likely reflects
  //    internally-transferred advance credit (from apply-credit or
  //    manual-credit-adjustment) rather than new cash — including it would
  //    double-count money already tallied in the source cycle or the
  //    non-cycle adjustment bucket.
  const cashRows: CashRow[] = [];
  const allKeys = new Set<string>([...mpByKey.keys(), ...ucpByKey.keys()]);
  for (const key of allKeys) {
    const [villaId, cycleId] = key.split(":") as [string, string];
    const mp = mpByKey.get(key);
    const ucp = ucpByKey.get(key);
    const mpSum = mp?.sum ?? 0;
    const ucpMax = ucp?.max ?? 0;
    // Only allow UCP to correct when there IS real MP cash (historical
    // capping recovery).  When mpSum ≈ 0, skip UCP entirely.
    const cashReceived = mpSum > 0.005 ? Math.max(mpSum, ucpMax) : 0;
    if (cashReceived <= 0.005) continue;
    const expected = expectedBySnap.get(key) ?? 0;
    // Pick the most recent date across the two ledgers.
    const dates: Date[] = [];
    if (mp?.latest) dates.push(mp.latest);
    if (ucp?.latest) dates.push(ucp.latest);
    const recentPaymentDate = dates.length > 0
      ? dates.reduce((a, b) => (a > b ? a : b))
      : null;
    cashRows.push({ villaId, cycleId, cashReceived, expected, recentPaymentDate });
  }

  // Aggregate maintenance cash totals. Cycle-attributed cash comes from
  // the reconciled `cashRows`; non-cycle cash flows in via the bucket
  // we accumulated above.
  let maintenanceCashAllTime = nonCycleCashAllTime;
  const maintenanceCashByMonth = new Map<string, number>(nonCycleCashByMonth);
  const maintenanceCashByCycle = new Map<string, number>();
  for (const row of cashRows) {
    maintenanceCashAllTime += row.cashReceived;
    maintenanceCashByCycle.set(
      row.cycleId,
      (maintenanceCashByCycle.get(row.cycleId) ?? 0) + row.cashReceived,
    );
    if (row.recentPaymentDate) {
      const k = ymKeyFromDate(row.recentPaymentDate);
      maintenanceCashByMonth.set(k, (maintenanceCashByMonth.get(k) ?? 0) + row.cashReceived);
    }
  }

  // Cycle-progress collected (capped per villa at expected) — drives
  // collection-rate / progress-bar UIs.
  const cycleProgressByCycle = new Map<string, number>();
  for (const s of snapshots) {
    const expected = Number(s.expectedAmount);
    const snapPaid = s.status === "WAIVED" ? expected : Number(s.paidAmount);
    const ucpMax = ucpByKey.get(`${s.villaId}:${s.cycleId}`)?.max ?? 0;
    const cash = Math.max(snapPaid, ucpMax);
    const capped = Math.min(cash, expected);
    cycleProgressByCycle.set(
      s.cycleId,
      (cycleProgressByCycle.get(s.cycleId) ?? 0) + capped,
    );
  }

  // Advance credit pool — use the shared credit walker (includes billing late
  // fees and unlinked manual adjustments) so society fund UI matches per-villa
  // admin/resident credit balances.
  const activeFy = await db.financialYear.findFirst({
    where: { societyId, status: "ACTIVE" },
    select: { id: true },
    orderBy: { startDate: "desc" },
  });
  let totalAdvanceCredit = 0;
  if (activeFy) {
    const creditBalances = await getVillaCreditBalancesBulk(db, {
      societyId,
      financialYearId: activeFy.id,
    });
    for (const pool of creditBalances.values()) {
      totalAdvanceCredit += pool;
    }
  }

  // Additional funds + expenses.
  let additionalFundsAllTime = 0;
  const additionalFundsByMonth = new Map<string, number>();
  for (const f of additionalFunds) {
    const v = Number(f.amount);
    additionalFundsAllTime += v;
    if (f.month && f.year) {
      const k = ymKey(f.month, f.year);
      additionalFundsByMonth.set(k, (additionalFundsByMonth.get(k) ?? 0) + v);
    } else if (f.receivedDate) {
      const k = ymKeyFromDate(f.receivedDate);
      additionalFundsByMonth.set(k, (additionalFundsByMonth.get(k) ?? 0) + v);
    }
  }

  let expensesAllTime = 0;
  const expensesByMonth = new Map<string, number>();
  for (const e of expenses) {
    const v = Number(e.amount);
    expensesAllTime += v;
    // Prefer explicit month/year attribution (admin's intent); fall back to
    // paymentDate calendar month when month/year are not set.
    if (e.month && e.year) {
      const k = ymKey(e.month, e.year);
      expensesByMonth.set(k, (expensesByMonth.get(k) ?? 0) + v);
    } else if (e.paymentDate) {
      const k = ymKeyFromDate(e.paymentDate);
      expensesByMonth.set(k, (expensesByMonth.get(k) ?? 0) + v);
    }
  }

  // Total expected maintenance across every (villa, cycle) snapshot.
  // Excludes WAIVED cycles — the society chose not to collect those.
  let expectedAllTime = 0;
  let outstandingDues = 0;
  for (const s of snapshots) {
    if (s.status === "WAIVED") continue;
    const expected = Number(s.expectedAmount);
    expectedAllTime += expected;
    const paid = Number(s.paidAmount);
    if (expected > paid) outstandingDues += expected - paid;
  }

  const currentFundBalance =
    maintenanceCashAllTime + additionalFundsAllTime - expensesAllTime;

  return {
    societyId,
    maintenanceCashAllTime,
    maintenanceCashForMonth(month: number, year: number) {
      return maintenanceCashByMonth.get(ymKey(month, year)) ?? 0;
    },
    maintenanceCashForCycle(id: string) {
      return maintenanceCashByCycle.get(id) ?? 0;
    },
    additionalFundsAllTime,
    additionalFundsForMonth(month: number, year: number) {
      return additionalFundsByMonth.get(ymKey(month, year)) ?? 0;
    },
    expensesAllTime,
    expensesForMonth(month: number, year: number) {
      return expensesByMonth.get(ymKey(month, year)) ?? 0;
    },
    currentFundBalance,
    cycleProgressCollectedForCycle(id: string) {
      return cycleProgressByCycle.get(id) ?? 0;
    },
    totalAdvanceCredit,
    expectedAllTime,
    outstandingDues,
  };
}
