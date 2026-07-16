import { Prisma, PrismaClient } from "@prisma/client";
import { advanceCreditWalkStep, refreshSnapshotStatus } from "./snapshot-helpers";
import {
  loadCreditWalkBillingContext,
  resolveWalkExpectedForCycle,
} from "./credit-walk-billing-context";

type Tx = Prisma.TransactionClient;
type ReadDb = PrismaClient | Tx;

const mcCycleSelect = {
  id: true,
  financialYearId: true,
  periodKey: true,
  dueDate: true,
  periodMonth: true,
  periodYear: true,
} as const;

const snapWalkSelect = {
  cycleId: true,
  expectedAmount: true,
  lateFeeAmount: true,
  lateFeeAppliedAt: true,
  paidAmount: true,
  status: true,
} as const;

/**
 * Re-derives every `VillaMaintenanceSnapshot.paidAmount` and `status` for a
 * villa from the underlying cash ledger (`MaintenancePayment` rows), applying
 * carried-forward overpayment as advance credit to later cycles.
 *
 * The walk is **global** — it traverses ALL cycles across ALL financial years
 * chronologically so that credit accumulated in FY1 carries forward into FY2.
 * Snapshots for **every** walked cycle are written (including cross-FY spillover).
 * `financialYearId` is retained for API compatibility; `throughCycleId` no longer
 * truncates the walk (credit must propagate to all later cycles).
 *
 * Walk semantics:
 *   1. List ALL the society's cycles in chronological order (period year/month).
 *   2. For each cycle, sum cash received specifically for that cycle from
 *      `MaintenancePayment` (linked via `maintenanceCollectionCycleId`).
 *   3. Unlinked adjustments are injected at the cycle matching their (month, year).
 *   4. `availableForCycle = cashThis + carryFromPriorOverpayment`.
 *   5. `applied = min(expected, availableForCycle)`. Status follows
 *      [refreshSnapshotStatus]; the residual feeds the next iteration's
 *      credit pool.
 *   6. `WAIVED` snapshots are left alone — they were intentionally zeroed
 *      out and don't consume credit.
 *
 * @param params.throughCycleId  Deprecated — kept for callers; walk always covers all cycles.
 */
export async function applyVillaCreditAcrossSnapshots(
  tx: Tx,
  params: {
    societyId: string;
    villaId: string;
    financialYearId: string;
    throughCycleId?: string;
  },
): Promise<void> {
  const { societyId, villaId, financialYearId, throughCycleId } = params;
  const nowUtc = new Date();

  const allCycles = await tx.maintenanceCollectionCycle.findMany({
    where: { societyId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: mcCycleSelect,
  });
  if (allCycles.length === 0) return;

  const billingCtx = await loadCreditWalkBillingContext(tx, societyId, [villaId]);

  // Credit is global — always walk and persist every chronological cycle so
  // overpayments / manual ADJ in FY1 update snapshots in FY2 (e.g. May→June).
  void financialYearId;
  void throughCycleId;
  const walkCycles = allCycles;
  const walkCycleIds = walkCycles.map((c) => c.id);

  const [snapshots, cashAgg, unlinkedRows] = await Promise.all([
    tx.villaMaintenanceSnapshot.findMany({
      where: { villaId, cycleId: { in: walkCycleIds } },
      select: { id: true, ...snapWalkSelect },
    }),
    tx.maintenancePayment.groupBy({
      by: ["maintenanceCollectionCycleId"],
      where: { societyId, villaId, maintenanceCollectionCycleId: { in: walkCycleIds } },
      _sum: { amount: true },
    }),
    tx.maintenancePayment.groupBy({
      by: ["month", "year"],
      where: { societyId, villaId, maintenanceCollectionCycleId: null },
      _sum: { amount: true },
    }),
  ]);

  const snapByCycle = new Map(snapshots.map((s) => [s.cycleId, s]));
  const cashByCycle = new Map<string, number>();
  for (const row of cashAgg) {
    if (row.maintenanceCollectionCycleId) {
      cashByCycle.set(row.maintenanceCollectionCycleId, Number(row._sum.amount || 0));
    }
  }
  const unlinkedByPeriod = new Map<string, number>();
  for (const row of unlinkedRows) {
    const val = Number(row._sum.amount || 0);
    if (Math.abs(val) > 0.005) unlinkedByPeriod.set(`${row.month}:${row.year}`, val);
  }

  let creditPool = 0;
  for (const cycle of walkCycles) {
    creditPool += unlinkedByPeriod.get(`${cycle.periodMonth}:${cycle.periodYear}`) ?? 0;

    const snap = snapByCycle.get(cycle.id);
    if (!snap) continue;
    if (snap.status === "WAIVED") continue;

    const expected = resolveWalkExpectedForCycle(billingCtx, cycle, snap, nowUtc);
    const cashThis = cashByCycle.get(cycle.id) ?? 0;
    // The pool is the villa's money and always carries forward — a cycle
    // covered by its own cash passes the prior pool through untouched.
    const step = advanceCreditWalkStep(expected, cashThis, creditPool);
    const applied = step.applied;
    creditPool = step.creditPool;

    const newStatus = refreshSnapshotStatus(expected, applied, cycle.dueDate);
    const paidUnchanged = Math.abs(applied - Number(snap.paidAmount)) < 0.005;
    const statusUnchanged = newStatus === snap.status;
    if (paidUnchanged && statusUnchanged) continue;

    await tx.villaMaintenanceSnapshot.update({
      where: { id: snap.id },
      data: { paidAmount: new Prisma.Decimal(applied), status: newStatus },
    });

    const maintStatus = newStatus === "PAID" ? "PAID" : newStatus === "OVERDUE" ? "OVERDUE" : "PENDING";
    await tx.maintenance.updateMany({
      where: { villaId, month: cycle.periodMonth, year: cycle.periodYear, societyId },
      data: { status: maintStatus },
    });
  }
}

/**
 * Read-only variant: computes the remaining advance-credit pool for a single
 * villa by walking ALL cycles globally (credit carries across FY boundaries).
 * The `financialYearId` parameter is kept for API compatibility but the walk
 * is not limited to it.
 *
 * `beforePeriod`: stop the walk BEFORE cycles at/after this (year, month) and
 * return the pool available entering that period — exactly the credit the
 * settle walker would apply to that cycle. Unlinked adjustments dated in the
 * target period itself are still injected (the settle walk injects them before
 * consuming). Use for checkout quotes so quoted credit always matches what
 * settlement can actually apply.
 */
export async function getVillaCreditBalance(
  db: ReadDb,
  params: {
    societyId: string;
    villaId: string;
    financialYearId?: string;
    beforePeriod?: { year: number; month: number };
  },
): Promise<{ creditPool: number }> {
  const { societyId, villaId, beforePeriod } = params;
  const nowUtc = new Date();

  let cycles = await db.maintenanceCollectionCycle.findMany({
    where: { societyId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: mcCycleSelect,
  });
  if (beforePeriod) {
    cycles = cycles.filter(
      (c) =>
        c.periodYear < beforePeriod.year ||
        (c.periodYear === beforePeriod.year && c.periodMonth < beforePeriod.month),
    );
  }
  if (cycles.length === 0 && !beforePeriod) return { creditPool: 0 };

  const billingCtx = await loadCreditWalkBillingContext(db, societyId, [villaId]);
  const cycleIds = cycles.map((c) => c.id);

  const [snapshots, cashAgg, unlinkedRows] = await Promise.all([
    db.villaMaintenanceSnapshot.findMany({
      where: { villaId, cycleId: { in: cycleIds } },
      select: snapWalkSelect,
    }),
    db.maintenancePayment.groupBy({
      by: ["maintenanceCollectionCycleId"],
      where: { societyId, villaId, maintenanceCollectionCycleId: { in: cycleIds } },
      _sum: { amount: true },
    }),
    db.maintenancePayment.groupBy({
      by: ["month", "year"],
      where: { societyId, villaId, maintenanceCollectionCycleId: null },
      _sum: { amount: true },
    }),
  ]);

  const snapByCycle = new Map(snapshots.map((s) => [s.cycleId, s]));
  const cashByCycle = new Map<string, number>();
  for (const row of cashAgg) {
    if (row.maintenanceCollectionCycleId) {
      cashByCycle.set(row.maintenanceCollectionCycleId, Number(row._sum.amount || 0));
    }
  }
  const unlinkedByPeriod = new Map<string, number>();
  for (const row of unlinkedRows) {
    const val = Number(row._sum.amount || 0);
    if (Math.abs(val) > 0.005) unlinkedByPeriod.set(`${row.month}:${row.year}`, val);
  }

  let creditPool = 0;
  for (const cycle of cycles) {
    creditPool += unlinkedByPeriod.get(`${cycle.periodMonth}:${cycle.periodYear}`) ?? 0;
    const snap = snapByCycle.get(cycle.id);
    if (!snap) continue;
    if (snap.status === "WAIVED") continue;
    const expected = resolveWalkExpectedForCycle(billingCtx, cycle, snap, nowUtc);
    const cashThis = cashByCycle.get(cycle.id) ?? 0;
    creditPool = advanceCreditWalkStep(expected, cashThis, creditPool).creditPool;
  }

  if (beforePeriod) {
    // The settle walk injects the target period's unlinked adjustments before
    // consuming credit for it — mirror that so the quote matches settlement.
    creditPool += unlinkedByPeriod.get(`${beforePeriod.month}:${beforePeriod.year}`) ?? 0;
    creditPool = Math.max(0, creditPool);
  }

  return { creditPool };
}

/**
 * Bulk variant: returns the remaining advance-credit pool for every villa
 * by walking ALL cycles globally (credit carries across FY boundaries).
 * The `financialYearId` parameter is kept for API compatibility.
 */
export async function getVillaCreditBalancesBulk(
  db: ReadDb,
  params: { societyId: string; financialYearId?: string },
): Promise<Map<string, number>> {
  const { societyId } = params;
  const nowUtc = new Date();

  const cycles = await db.maintenanceCollectionCycle.findMany({
    where: { societyId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: mcCycleSelect,
  });
  if (cycles.length === 0) return new Map();

  const cycleIds = cycles.map((c) => c.id);

  const snapshots = await db.villaMaintenanceSnapshot.findMany({
    where: { cycleId: { in: cycleIds } },
    select: { villaId: true, ...snapWalkSelect },
  });

  const villaIds = [...new Set(snapshots.map((s) => s.villaId))];
  const billingCtx = await loadCreditWalkBillingContext(db, societyId, villaIds);

  const [cashAgg, unlinkedRows] = await Promise.all([
    db.maintenancePayment.groupBy({
      by: ["villaId", "maintenanceCollectionCycleId"],
      where: { societyId, maintenanceCollectionCycleId: { in: cycleIds } },
      _sum: { amount: true },
    }),
    db.maintenancePayment.groupBy({
      by: ["villaId", "month", "year"],
      where: { societyId, maintenanceCollectionCycleId: null },
      _sum: { amount: true },
    }),
  ]);

  const villaSnaps = new Map<string, Map<string, (typeof snapshots)[number]>>();
  for (const s of snapshots) {
    let m = villaSnaps.get(s.villaId);
    if (!m) {
      m = new Map();
      villaSnaps.set(s.villaId, m);
    }
    m.set(s.cycleId, s);
  }

  const cashKey = (vid: string, cid: string) => `${vid}|${cid}`;
  const cashMap = new Map<string, number>();
  for (const row of cashAgg) {
    if (row.maintenanceCollectionCycleId) {
      cashMap.set(cashKey(row.villaId, row.maintenanceCollectionCycleId), Number(row._sum.amount || 0));
    }
  }
  const unlinkedByVillaPeriod = new Map<string, number>();
  for (const row of unlinkedRows) {
    const val = Number(row._sum.amount || 0);
    if (Math.abs(val) > 0.005) unlinkedByVillaPeriod.set(`${row.villaId}:${row.month}:${row.year}`, val);
  }

  const result = new Map<string, number>();
  for (const [villaId, snapsPerCycle] of villaSnaps) {
    let creditPool = 0;
    for (const cycle of cycles) {
      creditPool += unlinkedByVillaPeriod.get(`${villaId}:${cycle.periodMonth}:${cycle.periodYear}`) ?? 0;
      const snap = snapsPerCycle.get(cycle.id);
      if (!snap) continue;
      if (snap.status === "WAIVED") continue;
      const expected = resolveWalkExpectedForCycle(billingCtx, cycle, snap, nowUtc);
      const cash = cashMap.get(cashKey(villaId, cycle.id)) ?? 0;
      creditPool = advanceCreditWalkStep(expected, cash, creditPool).creditPool;
    }
    result.set(villaId, creditPool);
  }

  return result;
}
