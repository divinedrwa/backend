import { Prisma, PrismaClient } from "@prisma/client";
import { refreshSnapshotStatus, resolveSnapshotExpectedTotal } from "./snapshot-helpers";

type Tx = Prisma.TransactionClient;
type ReadDb = PrismaClient | Tx;

/**
 * Re-derives every `VillaMaintenanceSnapshot.paidAmount` and `status` for a
 * villa from the underlying cash ledger (`MaintenancePayment` rows), applying
 * carried-forward overpayment as advance credit to later cycles.
 *
 * The walk is **global** — it traverses ALL cycles across ALL financial years
 * chronologically so that credit accumulated in FY1 carries forward into FY2.
 * Only snapshots within the target `financialYearId` (and up to
 * `throughCycleId` when set) are actually written.
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
 * @param params.throughCycleId  When set, the walker only reconciles
 *   cycles up to and including this cycle (within the target FY).
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

  // Fetch ALL cycles across ALL FYs for global walk.
  const allCycles = await tx.maintenanceCollectionCycle.findMany({
    where: { societyId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: { id: true, financialYearId: true, dueDate: true, periodMonth: true, periodYear: true },
  });
  if (allCycles.length === 0) return;

  // Determine which cycles are writable (in target FY, up to throughCycleId).
  const targetFyCycleIds = new Set<string>();
  for (const c of allCycles) {
    if (c.financialYearId !== financialYearId) continue;
    targetFyCycleIds.add(c.id);
    if (c.id === throughCycleId) break;
  }

  // Stop the global walk at throughCycleId (no point walking past it).
  let walkCycles = allCycles;
  if (throughCycleId) {
    const idx = allCycles.findIndex((c) => c.id === throughCycleId);
    if (idx >= 0) walkCycles = allCycles.slice(0, idx + 1);
  }

  const walkCycleIds = walkCycles.map((c) => c.id);

  const [snapshots, cashAgg, unlinkedRows] = await Promise.all([
    tx.villaMaintenanceSnapshot.findMany({
      where: { villaId, cycleId: { in: walkCycleIds } },
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

    const expected = resolveSnapshotExpectedTotal(snap.expectedAmount, snap.lateFeeAmount);
    const cashThis = cashByCycle.get(cycle.id) ?? 0;
    const availableForCycle = cashThis + creditPool;
    const applied = Math.min(expected, Math.max(0, availableForCycle));
    creditPool = Math.max(0, availableForCycle - expected);

    // Only write updates for cycles in the target FY.
    if (!targetFyCycleIds.has(cycle.id)) continue;

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
 */
export async function getVillaCreditBalance(
  db: ReadDb,
  params: { societyId: string; villaId: string; financialYearId: string },
): Promise<{ creditPool: number }> {
  const { societyId, villaId } = params;

  const cycles = await db.maintenanceCollectionCycle.findMany({
    where: { societyId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: { id: true, periodMonth: true, periodYear: true },
  });
  if (cycles.length === 0) return { creditPool: 0 };

  const cycleIds = cycles.map((c) => c.id);

  const [snapshots, cashAgg, unlinkedRows] = await Promise.all([
    db.villaMaintenanceSnapshot.findMany({
      where: { villaId, cycleId: { in: cycleIds } },
      select: { cycleId: true, expectedAmount: true, lateFeeAmount: true, status: true },
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
    const expected = resolveSnapshotExpectedTotal(snap.expectedAmount, snap.lateFeeAmount);
    const cashThis = cashByCycle.get(cycle.id) ?? 0;
    creditPool = Math.max(0, cashThis + creditPool - expected);
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
  params: { societyId: string; financialYearId: string },
): Promise<Map<string, number>> {
  const { societyId } = params;

  const cycles = await db.maintenanceCollectionCycle.findMany({
    where: { societyId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: { id: true, periodMonth: true, periodYear: true },
  });
  if (cycles.length === 0) return new Map();

  const cycleIds = cycles.map((c) => c.id);

  const [snapshots, cashAgg, unlinkedRows] = await Promise.all([
    db.villaMaintenanceSnapshot.findMany({
      where: { cycleId: { in: cycleIds } },
      select: { villaId: true, cycleId: true, expectedAmount: true, lateFeeAmount: true, status: true },
    }),
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

  // Group snapshots per villa, keyed by cycleId
  const villaSnaps = new Map<string, Map<string, { expected: number; status: string }>>();
  for (const s of snapshots) {
    let m = villaSnaps.get(s.villaId);
    if (!m) { m = new Map(); villaSnaps.set(s.villaId, m); }
    m.set(s.cycleId, {
      expected: resolveSnapshotExpectedTotal(s.expectedAmount, s.lateFeeAmount),
      status: s.status,
    });
  }

  // Cash per (villa, cycle)
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
      const cash = cashMap.get(cashKey(villaId, cycle.id)) ?? 0;
      creditPool = Math.max(0, cash + creditPool - snap.expected);
    }
    result.set(villaId, creditPool);
  }

  return result;
}
