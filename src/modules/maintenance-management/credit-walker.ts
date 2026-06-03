import { Prisma, PrismaClient } from "@prisma/client";
import { refreshSnapshotStatus } from "./snapshot-helpers";

type Tx = Prisma.TransactionClient;
type ReadDb = PrismaClient | Tx;

/**
 * Build a Prisma filter that matches unlinked payments belonging to the
 * given financial year by matching their (month, year) against cycle periods.
 * This works whether or not the `financialYearId` migration has been applied.
 */
function buildUnlinkedFyFilter(
  societyId: string,
  cyclePeriods: Array<{ month: number; year: number }>,
  villaId?: string,
): Prisma.MaintenancePaymentWhereInput {
  const base: Prisma.MaintenancePaymentWhereInput = {
    societyId,
    maintenanceCollectionCycleId: null,
    ...(villaId ? { villaId } : {}),
  };
  // De-duplicate (month, year) pairs
  const seen = new Set<string>();
  const periodFilters: Prisma.MaintenancePaymentWhereInput[] = [];
  for (const p of cyclePeriods) {
    const key = `${p.month}-${p.year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    periodFilters.push({ month: p.month, year: p.year });
  }
  if (periodFilters.length === 0) return { ...base, id: "__impossible__" };
  return { ...base, OR: periodFilters };
}

/**
 * Unlinked adjustment payments for a single villa, grouped by (month, year).
 * Returns a Map keyed by "month:year" → amount, so the walker can inject
 * each period's adjustments at the matching cycle instead of seeding all upfront.
 */
async function getUnlinkedAdjustmentsByPeriod(
  db: ReadDb,
  params: {
    societyId: string;
    villaId: string;
    cyclePeriods: Array<{ month: number; year: number }>;
  },
): Promise<Map<string, number>> {
  const rows = await db.maintenancePayment.groupBy({
    by: ["month", "year"],
    where: buildUnlinkedFyFilter(
      params.societyId,
      params.cyclePeriods,
      params.villaId,
    ),
    _sum: { amount: true },
  });
  const result = new Map<string, number>();
  for (const row of rows) {
    const val = Number(row._sum.amount || 0);
    if (Math.abs(val) > 0.005) result.set(`${row.month}:${row.year}`, val);
  }
  return result;
}

/**
 * Bulk variant: unlinked adjustment payments per (villa, month, year).
 * Returns a Map keyed by "villaId:month:year" → amount.
 */
async function getUnlinkedAdjustmentsByPeriodBulk(
  db: ReadDb,
  params: {
    societyId: string;
    cyclePeriods: Array<{ month: number; year: number }>;
  },
): Promise<Map<string, number>> {
  const rows = await db.maintenancePayment.groupBy({
    by: ["villaId", "month", "year"],
    where: buildUnlinkedFyFilter(
      params.societyId,
      params.cyclePeriods,
    ),
    _sum: { amount: true },
  });
  const result = new Map<string, number>();
  for (const row of rows) {
    const val = Number(row._sum.amount || 0);
    if (Math.abs(val) > 0.005) result.set(`${row.villaId}:${row.month}:${row.year}`, val);
  }
  return result;
}

/**
 * Re-derives every `VillaMaintenanceSnapshot.paidAmount` and `status` for a
 * villa within a financial year from the underlying cash ledger
 * (`MaintenancePayment` rows), applying carried-forward overpayment as
 * advance credit to later cycles.
 *
 * Why a centralised walker:
 *   - `snapshot.paidAmount` is the source of truth that the dashboard reads
 *     for cycle-progress totals (and the residents grid uses for status).
 *     Direct increments at payment time make it impossible to express "this
 *     cycle was settled by credit from a prior overpayment".
 *   - Reconciling chronologically is idempotent: running it twice in a row
 *     leaves the same result, so it's safe to call after every payment
 *     write (mark-cash, mark-paid, waive, etc.) without bookkeeping.
 *
 * Walk semantics:
 *   1. List the villa's snapshots in cycle order (period year/month asc).
 *   2. For each cycle, sum cash received specifically for that cycle from
 *      `MaintenancePayment` (linked via `maintenanceCollectionCycleId`).
 *   3. `availableForCycle = cashThis + carryFromPriorOverpayment`.
 *   4. `applied = min(expected, availableForCycle)`. Status follows
 *      [refreshSnapshotStatus]; the residual feeds the next iteration's
 *      credit pool.
 *   5. `WAIVED` snapshots are left alone — they were intentionally zeroed
 *      out and don't consume credit.
 *
 * The matching `Maintenance` row (legacy bill model) is also reconciled so
 * lists that read it (`/maintenance/dashboard`, etc.) stay in sync.
 */
/**
 * @param params.throughCycleId  When set, the walker only reconciles
 *   cycles up to and including this cycle. Credit excess from the last
 *   walked cycle is **not** carried forward to later ones, so advance
 *   credit is never auto-applied — the admin must explicitly trigger
 *   "Apply credit" for each target cycle.
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

  const allCycles = await tx.maintenanceCollectionCycle.findMany({
    where: { societyId, financialYearId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: { id: true, dueDate: true, periodMonth: true, periodYear: true },
  });
  if (allCycles.length === 0) return;

  // Limit walk to cycles up to throughCycleId (inclusive).
  let cycles = allCycles;
  if (throughCycleId) {
    const idx = allCycles.findIndex((c) => c.id === throughCycleId);
    if (idx >= 0) {
      cycles = allCycles.slice(0, idx + 1);
    }
  }

  const cycleIds = cycles.map((c) => c.id);
  const cyclePeriods = allCycles.map((c) => ({ month: c.periodMonth, year: c.periodYear }));

  const [snapshots, cashAgg, unlinkedByPeriod] = await Promise.all([
    tx.villaMaintenanceSnapshot.findMany({
      where: { villaId, cycleId: { in: cycleIds } },
    }),
    tx.maintenancePayment.groupBy({
      by: ["maintenanceCollectionCycleId"],
      where: {
        societyId,
        villaId,
        maintenanceCollectionCycleId: { in: cycleIds },
      },
      _sum: { amount: true },
    }),
    getUnlinkedAdjustmentsByPeriod(tx, { societyId, villaId, cyclePeriods }),
  ]);

  const snapByCycle = new Map(snapshots.map((s) => [s.cycleId, s]));
  const cashByCycle = new Map<string, number>();
  for (const row of cashAgg) {
    if (row.maintenanceCollectionCycleId) {
      cashByCycle.set(
        row.maintenanceCollectionCycleId,
        Number(row._sum.amount || 0),
      );
    }
  }

  // Inject unlinked adjustments at the matching cycle period (not all upfront)
  // so a May adjustment can't retroactively pay April's cycle.
  let creditPool = 0;
  for (const cycle of cycles) {
    // Inject unlinked adjustments that match this cycle's period
    creditPool += unlinkedByPeriod.get(`${cycle.periodMonth}:${cycle.periodYear}`) ?? 0;

    const snap = snapByCycle.get(cycle.id);
    if (!snap) continue;

    if (snap.status === "WAIVED") {
      // Waived cycles don't consume credit and don't change.
      continue;
    }

    const expected = Number(snap.expectedAmount);
    const cashThis = cashByCycle.get(cycle.id) ?? 0;
    const availableForCycle = cashThis + creditPool;
    const applied = Math.min(expected, Math.max(0, availableForCycle));
    creditPool = Math.max(0, availableForCycle - expected);

    const newStatus = refreshSnapshotStatus(expected, applied, cycle.dueDate);

    const paidUnchanged = Math.abs(applied - Number(snap.paidAmount)) < 0.005;
    const statusUnchanged = newStatus === snap.status;
    if (paidUnchanged && statusUnchanged) continue;

    await tx.villaMaintenanceSnapshot.update({
      where: { id: snap.id },
      data: {
        paidAmount: new Prisma.Decimal(applied),
        status: newStatus,
      },
    });

    // Keep the legacy `Maintenance` row in sync for endpoints that still
    // read it (the `/maintenance/dashboard` count cards in particular).
    const maintStatus =
      newStatus === "PAID"
        ? "PAID"
        : newStatus === "OVERDUE"
          ? "OVERDUE"
          : "PENDING";
    await tx.maintenance.updateMany({
      where: {
        villaId,
        month: cycle.periodMonth,
        year: cycle.periodYear,
        societyId,
      },
      data: { status: maintStatus },
    });
  }
}

/**
 * Read-only variant of the walker: computes the remaining advance-credit
 * pool for a single villa in a financial year without writing anything.
 */
export async function getVillaCreditBalance(
  db: ReadDb,
  params: { societyId: string; villaId: string; financialYearId: string },
): Promise<{ creditPool: number }> {
  const { societyId, villaId, financialYearId } = params;

  const cycles = await db.maintenanceCollectionCycle.findMany({
    where: { societyId, financialYearId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: { id: true, periodMonth: true, periodYear: true },
  });
  if (cycles.length === 0) return { creditPool: 0 };

  const cycleIds = cycles.map((c) => c.id);
  const cyclePeriods = cycles.map((c) => ({ month: c.periodMonth, year: c.periodYear }));

  const [snapshots, cashAgg, unlinkedByPeriod] = await Promise.all([
    db.villaMaintenanceSnapshot.findMany({
      where: { villaId, cycleId: { in: cycleIds } },
      select: { cycleId: true, expectedAmount: true, status: true },
    }),
    db.maintenancePayment.groupBy({
      by: ["maintenanceCollectionCycleId"],
      where: { societyId, villaId, maintenanceCollectionCycleId: { in: cycleIds } },
      _sum: { amount: true },
    }),
    getUnlinkedAdjustmentsByPeriod(db, { societyId, villaId, cyclePeriods }),
  ]);

  const snapByCycle = new Map(snapshots.map((s) => [s.cycleId, s]));
  const cashByCycle = new Map<string, number>();
  for (const row of cashAgg) {
    if (row.maintenanceCollectionCycleId) {
      cashByCycle.set(row.maintenanceCollectionCycleId, Number(row._sum.amount || 0));
    }
  }

  // Inject unlinked adjustments at the matching cycle period (not all upfront).
  let creditPool = 0;
  for (const cycle of cycles) {
    creditPool += unlinkedByPeriod.get(`${cycle.periodMonth}:${cycle.periodYear}`) ?? 0;
    const snap = snapByCycle.get(cycle.id);
    if (!snap) continue;
    if (snap.status === "WAIVED") continue;
    const expected = Number(snap.expectedAmount);
    const cashThis = cashByCycle.get(cycle.id) ?? 0;
    const available = cashThis + creditPool;
    creditPool = Math.max(0, available - expected);
  }

  return { creditPool };
}

/**
 * Bulk variant: returns the remaining advance-credit pool for every villa
 * that has snapshots in the given financial year.
 */
export async function getVillaCreditBalancesBulk(
  db: ReadDb,
  params: { societyId: string; financialYearId: string },
): Promise<Map<string, number>> {
  const { societyId, financialYearId } = params;

  const cycles = await db.maintenanceCollectionCycle.findMany({
    where: { societyId, financialYearId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: { id: true, periodMonth: true, periodYear: true },
  });
  if (cycles.length === 0) return new Map();

  const cycleIds = cycles.map((c) => c.id);
  const cyclePeriods = cycles.map((c) => ({ month: c.periodMonth, year: c.periodYear }));

  const [snapshots, cashAgg, unlinkedByPeriod] = await Promise.all([
    db.villaMaintenanceSnapshot.findMany({
      where: { cycleId: { in: cycleIds } },
      select: { villaId: true, cycleId: true, expectedAmount: true, status: true },
    }),
    db.maintenancePayment.groupBy({
      by: ["villaId", "maintenanceCollectionCycleId"],
      where: { societyId, maintenanceCollectionCycleId: { in: cycleIds } },
      _sum: { amount: true },
    }),
    getUnlinkedAdjustmentsByPeriodBulk(db, { societyId, cyclePeriods }),
  ]);

  // Group snapshots per villa, keyed by cycleId
  const villaSnaps = new Map<string, Map<string, { expected: number; status: string }>>();
  for (const s of snapshots) {
    let m = villaSnaps.get(s.villaId);
    if (!m) { m = new Map(); villaSnaps.set(s.villaId, m); }
    m.set(s.cycleId, { expected: Number(s.expectedAmount), status: s.status });
  }

  // Cash per (villa, cycle)
  const cashKey = (vid: string, cid: string) => `${vid}|${cid}`;
  const cashMap = new Map<string, number>();
  for (const row of cashAgg) {
    if (row.maintenanceCollectionCycleId) {
      cashMap.set(cashKey(row.villaId, row.maintenanceCollectionCycleId), Number(row._sum.amount || 0));
    }
  }

  const result = new Map<string, number>();
  for (const [villaId, snapsPerCycle] of villaSnaps) {
    // Inject unlinked adjustments at the matching cycle period (not all upfront).
    let creditPool = 0;
    for (const cycle of cycles) {
      creditPool += unlinkedByPeriod.get(`${villaId}:${cycle.periodMonth}:${cycle.periodYear}`) ?? 0;
      const snap = snapsPerCycle.get(cycle.id);
      if (!snap) continue;
      if (snap.status === "WAIVED") continue;
      const cash = cashMap.get(cashKey(villaId, cycle.id)) ?? 0;
      const available = cash + creditPool;
      creditPool = Math.max(0, available - snap.expected);
    }
    result.set(villaId, creditPool);
  }

  return result;
}
