import { MaintenanceBillingRole } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { deriveCycleStatusUtc } from "../domain/cycleStatus";
import { ensureVillaLedgersAligned } from "../billing-collection-link";
import { computeUserBillingLedger } from "./cycle-service";

export type UserPendingDueRow = {
  cycleId: string;
  cycleKey: string;
  title: string;
  /** Remaining cash due for this cycle (snapshot/ledger truth). */
  amount: number;
  expectedAmount: number;
  remainingDue: number;
  paymentEndDate: string;
  gracePeriodDays: number;
  isGraceOver: boolean;
  isOverdue: boolean;
  status: string;
};

/**
 * Align billing ↔ maintenance ledgers for recent cycles before resident reads.
 * Keeps mobile/web pending lists in sync with admin collection grid.
 *
 * **Performance guard:** skips if the same villa was reconciled within the last
 * `RECONCILE_COOLDOWN_MS` (default 2 min). This prevents every page-load from
 * running 36-cycle alignment (~200-300 DB ops). Mutations that change payment
 * state should call `invalidateReconcileCache(villaId)` so the next read
 * re-reconciles immediately.
 */
const RECONCILE_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
const _reconcileTimestamps = new Map<string, number>();

/** Clear the time-gate so the next read re-reconciles for this villa. */
export function invalidateReconcileCache(villaId: string): void {
  _reconcileTimestamps.delete(villaId);
}

export async function reconcileVillaLedgersForRecentCycles(
  societyId: string,
  villaId: string,
  maxCycles = 36,
): Promise<void> {
  const now = Date.now();
  const lastRun = _reconcileTimestamps.get(villaId);
  if (lastRun && now - lastRun < RECONCILE_COOLDOWN_MS) {
    return; // Recently reconciled — skip
  }

  const cycles = await prisma.billingCycle.findMany({
    where: { societyId },
    orderBy: { cycleKey: "desc" },
    take: maxCycles,
    select: { id: true },
  });
  if (cycles.length === 0) return;

  await prisma.$transaction(async (tx) => {
    for (const c of cycles) {
      await ensureVillaLedgersAligned(tx, {
        societyId,
        villaId,
        billingCycleId: c.id,
        note: "Auto-align before resident pending read",
      });
    }
  });

  _reconcileTimestamps.set(villaId, Date.now());
}

/**
 * Canonical pending-dues list for a billing subject (resident or admin-with-villa).
 * Uses [computeUserBillingLedger] — same source as pay-all and maintenance-pending.
 */
export async function buildPendingDuesFromLedger(
  societyId: string,
  userId: string,
  nowUtc = new Date(),
): Promise<UserPendingDueRow[]> {
  const billingSubject = await prisma.user.findFirst({
    where: { id: userId, societyId },
    select: { maintenanceBillingRole: true },
  });
  if (billingSubject?.maintenanceBillingRole === MaintenanceBillingRole.EXCLUDED) {
    return [];
  }

  const [ledger, cycles] = await Promise.all([
    computeUserBillingLedger(societyId, userId),
    prisma.billingCycle.findMany({
      where: { societyId },
      select: {
        id: true,
        cycleKey: true,
        title: true,
        paymentStartDate: true,
        paymentEndDate: true,
        gracePeriodDays: true,
      },
    }),
  ]);

  const cycleById = new Map(cycles.map((c) => [c.id, c]));
  const rows: UserPendingDueRow[] = [];

  for (const row of ledger.cycles) {
    const remainingDue = Math.max(0, row.expectedAmount - row.cashPaidAmount);
    if (remainingDue <= 0.005) continue;

    const cycle = cycleById.get(row.cycleId);
    if (!cycle) continue;

    const isGraceOver =
      nowUtc.getTime() >
      cycle.paymentEndDate.getTime() + cycle.gracePeriodDays * 24 * 60 * 60 * 1000;
    const isOverdue = cycle.paymentEndDate.getTime() < nowUtc.getTime();
    const status = deriveCycleStatusUtc(
      nowUtc,
      cycle.paymentStartDate,
      cycle.paymentEndDate,
    );

    rows.push({
      cycleId: row.cycleId,
      cycleKey: row.cycleKey,
      title: row.title ?? cycle.title,
      amount: remainingDue,
      expectedAmount: row.expectedAmount,
      remainingDue,
      paymentEndDate: cycle.paymentEndDate.toISOString(),
      gracePeriodDays: cycle.gracePeriodDays,
      isGraceOver,
      isOverdue,
      status,
    });
  }

  return rows.sort((a, b) => a.cycleKey.localeCompare(b.cycleKey));
}

export function pendingDuesToCurrentCycleShape(rows: UserPendingDueRow[]): Array<{
  cycleId: string;
  cycleKey: string;
  title: string;
  amount: number;
  paymentEndDate: string;
  gracePeriodDays: number;
  isGraceOver: boolean;
  status: string;
}> {
  return rows.map((r) => ({
    cycleId: r.cycleId,
    cycleKey: r.cycleKey,
    title: r.title,
    amount: r.amount,
    paymentEndDate: r.paymentEndDate,
    gracePeriodDays: r.gracePeriodDays,
    isGraceOver: r.isGraceOver,
    status: r.status,
  }));
}
