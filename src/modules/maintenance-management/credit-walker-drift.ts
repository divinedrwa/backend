import { Prisma, PrismaClient } from "@prisma/client";
import { advanceCreditWalkStep, refreshSnapshotStatus } from "./snapshot-helpers";
import {
  loadCreditWalkBillingContext,
  resolveWalkExpectedForCycle,
} from "./credit-walk-billing-context";

type ReadDb = PrismaClient | Prisma.TransactionClient;

export type VillaCreditWalkStep = {
  cycleId: string;
  periodKey: string;
  title: string;
  expected: number;
  cashThis: number;
  creditApplied: number;
  applied: number;
  creditPoolAfter: number;
  expectedStatus: "PENDING" | "PARTIAL" | "PAID" | "OVERDUE" | "WAIVED";
  snapshotPaid: number;
  snapshotStatus: string;
  drift: boolean;
};

export type VillaCreditDriftRow = {
  villaId: string;
  block: string;
  villaNumber: string;
  cycleId: string;
  periodKey: string;
  title: string;
  expectedPaid: number;
  snapshotPaid: number;
  expectedStatus: string;
  snapshotStatus: string;
  creditApplied: number;
  cashThis: number;
};

/**
 * Simulates the global credit walk for one villa and compares each snapshot
 * to what the walker would derive from cash + unlinked ADJ rows.
 */
export async function simulateVillaCreditWalk(
  db: ReadDb,
  params: { societyId: string; villaId: string },
  nowUtc = new Date(),
): Promise<VillaCreditWalkStep[]> {
  const { societyId, villaId } = params;

  const allCycles = await db.maintenanceCollectionCycle.findMany({
    where: { societyId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: {
      id: true,
      title: true,
      periodKey: true,
      dueDate: true,
      periodMonth: true,
      periodYear: true,
      financialYearId: true,
    },
  });
  if (allCycles.length === 0) return [];

  const cycleIds = allCycles.map((c) => c.id);
  const billingCtx = await loadCreditWalkBillingContext(db, societyId, [villaId]);

  const [snapshots, cashAgg, unlinkedRows] = await Promise.all([
    db.villaMaintenanceSnapshot.findMany({
      where: { villaId, cycleId: { in: cycleIds } },
      select: {
        cycleId: true,
        expectedAmount: true,
        lateFeeAmount: true,
        lateFeeAppliedAt: true,
        paidAmount: true,
        status: true,
      },
    }),
    db.maintenancePayment.groupBy({
      by: ["maintenanceCollectionCycleId"],
      where: {
        societyId,
        villaId,
        maintenanceCollectionCycleId: { in: cycleIds },
        reversedAt: null,
      },
      _sum: { amount: true },
    }),
    db.maintenancePayment.groupBy({
      by: ["month", "year"],
      where: { societyId, villaId, maintenanceCollectionCycleId: null, reversedAt: null },
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

  const steps: VillaCreditWalkStep[] = [];
  let creditPool = 0;

  for (const cycle of allCycles) {
    creditPool += unlinkedByPeriod.get(`${cycle.periodMonth}:${cycle.periodYear}`) ?? 0;

    const snap = snapByCycle.get(cycle.id);
    if (!snap || snap.status === "WAIVED") continue;

    const expected = resolveWalkExpectedForCycle(billingCtx, cycle, snap, nowUtc);
    const cashThis = cashByCycle.get(cycle.id) ?? 0;
    const step = advanceCreditWalkStep(expected, cashThis, creditPool);
    creditPool = step.creditPool;
    const creditApplied = Math.max(0, step.applied - cashThis);
    const expectedStatus = refreshSnapshotStatus(expected, step.applied, cycle.dueDate);
    const snapshotPaid = Number(snap.paidAmount);
    const drift =
      Math.abs(snapshotPaid - step.applied) > 0.01 || snap.status !== expectedStatus;

    steps.push({
      cycleId: cycle.id,
      periodKey: cycle.periodKey,
      title: cycle.title,
      expected,
      cashThis,
      creditApplied,
      applied: step.applied,
      creditPoolAfter: creditPool,
      expectedStatus,
      snapshotPaid,
      snapshotStatus: snap.status,
      drift,
    });
  }

  return steps;
}

/** Returns snapshot rows where stored paid/status diverges from the credit walk. */
export async function findVillaCreditDrift(
  db: ReadDb,
  params: { societyId: string; villaId: string },
): Promise<VillaCreditDriftRow[]> {
  const villa = await db.villa.findFirst({
    where: { id: params.villaId, societyId: params.societyId },
    select: { block: true, villaNumber: true },
  });
  if (!villa) return [];

  const steps = await simulateVillaCreditWalk(db, params);
  return steps
    .filter((s) => s.drift)
    .map((s) => ({
      villaId: params.villaId,
      block: villa.block ?? "",
      villaNumber: villa.villaNumber,
      cycleId: s.cycleId,
      periodKey: s.periodKey,
      title: s.title,
      expectedPaid: s.applied,
      snapshotPaid: s.snapshotPaid,
      expectedStatus: s.expectedStatus,
      snapshotStatus: s.snapshotStatus,
      creditApplied: s.creditApplied,
      cashThis: s.cashThis,
    }));
}

/** Society-wide drift scan — use in ops scripts / reconciliation health checks. */
export async function findSocietyCreditDrift(
  db: ReadDb,
  societyId: string,
): Promise<VillaCreditDriftRow[]> {
  const villas = await db.villa.findMany({
    where: { societyId },
    select: { id: true },
  });
  const rows: VillaCreditDriftRow[] = [];
  for (const v of villas) {
    rows.push(...(await findVillaCreditDrift(db, { societyId, villaId: v.id })));
  }
  return rows;
}
