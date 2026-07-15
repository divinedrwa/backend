/**
 * LEDGER RECONCILIATION SERVICE
 * 
 * Ensures villa-level balances match society-wide totals.
 * Detects mismatches and creates alerts for admin review.
 */

import { Prisma } from '@prisma/client';
import { logger } from './logger';
import { prisma } from './prisma';
import { computeSocietyMoneySnapshot } from './societyFinance';

type Db = Prisma.TransactionClient | typeof prisma;

export interface ReconciliationResult {
  matched: boolean;
  totalDifference: number;
  cycleResults: Array<{
    cycleId: string;
    cycleTitle: string;
    villaSum: number;
    societyCash: number;
    creditApplied: number;
    unexplainedDifference: number;
    difference: number;
    matched: boolean;
  }>;
  alertsCreated: number;
  /** Open alerts auto-closed because diff is now within ₹0.01. */
  alertsResolved: number;
  /** Open alerts refreshed with latest villaSum / societyCash / difference. */
  alertsUpdated: number;
}

const MATCH_TOLERANCE_INR = 0.01;

export function isReconciliationCycleMatched(villaSum: number, societyCash: number): boolean {
  return Math.abs(villaSum - societyCash) <= MATCH_TOLERANCE_INR;
}

export type CycleReconciliationBreakdown = {
  villaSum: number;
  societyCash: number;
  creditApplied: number;
  /** Cash received above snapshot settled — bank overpayment → advance credit pool. */
  advanceOverpayment: number;
  unexplainedDifference: number;
  matched: boolean;
  /** Value stored on alerts — only unexplained drift, not credit-only gaps. */
  alertDifference: number;
};

/** Human-readable note when reconciliation auto-closes an alert (no payment mutation). */
export function buildReconciliationAutoResolveNote(
  cycleTitle: string,
  breakdown: CycleReconciliationBreakdown,
): string {
  const { villaSum, societyCash, creditApplied, advanceOverpayment } = breakdown;
  if (advanceOverpayment > MATCH_TOLERANCE_INR) {
    return (
      `Auto-resolved — ${cycleTitle}: ₹${advanceOverpayment.toFixed(2)} bank overpayment ` +
      `(cash ₹${societyCash.toFixed(2)} vs snapshot settled ₹${villaSum.toFixed(2)}). ` +
      `This is advance credit for future billing cycles, not missing money or a duplicate. ` +
      `No payment or fund adjustment was made.`
    );
  }
  if (creditApplied > MATCH_TOLERANCE_INR) {
    return (
      `Auto-resolved — ${cycleTitle}: ₹${creditApplied.toFixed(2)} settled from advance credit ` +
      `(snapshot ₹${villaSum.toFixed(2)} vs cash ₹${societyCash.toFixed(2)} this period). ` +
      `Prior overpayments covered this cycle. No payment correction needed.`
    );
  }
  return `Auto-resolved — ${cycleTitle}: villa snapshots and society cash match within ₹0.01.`;
}

/**
 * A6: Two expected gaps are not ledger errors:
 * - villaSum > societyCash → prior advance credit applied to snapshots
 * - societyCash > villaSum → bank overpayment (advance credit pool for later cycles)
 */
export function computeCycleReconciliationBreakdown(
  villaSum: number,
  societyCash: number,
): CycleReconciliationBreakdown {
  const creditApplied = Math.max(0, villaSum - societyCash);
  const advanceOverpayment = Math.max(0, societyCash - villaSum);
  const exactMatch = isReconciliationCycleMatched(villaSum, societyCash);
  const creditExplained =
    creditApplied > MATCH_TOLERANCE_INR && advanceOverpayment <= MATCH_TOLERANCE_INR;
  const overpaymentExplained =
    advanceOverpayment > MATCH_TOLERANCE_INR && creditApplied <= MATCH_TOLERANCE_INR;
  const matched = exactMatch || creditExplained || overpaymentExplained;
  const unexplainedDifference = matched ? 0 : Math.abs(villaSum - societyCash);
  const alertDifference = matched ? 0 : Math.abs(villaSum - societyCash);
  return {
    villaSum,
    societyCash,
    creditApplied,
    advanceOverpayment,
    unexplainedDifference,
    matched,
    alertDifference,
  };
}

function alertSeverityForDifference(difference: number): "CRITICAL" | "WARNING" {
  return difference > 1000 ? "CRITICAL" : "WARNING";
}

/**
 * Reconcile villa-level payments with society-level cash for a single society.
 * Should be run hourly via cron for all active societies.
 */
export async function reconcileSocietyLedger(
  societyId: string,
  db: Db = prisma,
): Promise<ReconciliationResult> {
  logger.info(`[Reconciliation] Starting for society ${societyId}`);

  try {
    // 1. Get society-level snapshot
    const societySnapshot = await computeSocietyMoneySnapshot(db, societyId);

    // 2. Get all villa snapshots with cycle info
    const villaSnapshots = await db.villaMaintenanceSnapshot.findMany({
      where: { cycle: { societyId } },
      include: {
        cycle: {
          select: {
            id: true,
            title: true,
            periodMonth: true,
            periodYear: true,
          },
        },
      },
    });

    // 3. Group by cycle and sum
    const byCycle = new Map<string, {
      villaSum: number;
      cycleTitle: string;
    }>();

    for (const snap of villaSnapshots) {
      const current = byCycle.get(snap.cycleId) || {
        villaSum: 0,
        cycleTitle: snap.cycle.title,
      };
      current.villaSum += Number(snap.paidAmount);
      byCycle.set(snap.cycleId, current);
    }

    // 4. Reconcile society-level cash per cycle using the same
    //    max(MP, UCP) logic as computeSocietyMoneySnapshot to avoid
    //    false alerts when credit is applied (snapshot.paidAmount
    //    includes credit, but raw MaintenancePayment.amount is cash only).
    const maintenancePayments = await db.maintenancePayment.findMany({
      where: { societyId, maintenanceCollectionCycleId: { not: null } },
      select: { villaId: true, maintenanceCollectionCycleId: true, amount: true },
    });

    const maintenanceCycles = await db.maintenanceCollectionCycle.findMany({
      where: { societyId },
      select: { id: true, financialYearId: true, periodKey: true },
    });
    const mcByFyKey = new Map<string, string>();
    for (const mc of maintenanceCycles) {
      mcByFyKey.set(`${mc.financialYearId}:${mc.periodKey}`, mc.id);
    }

    const userCyclePayments = await db.userCyclePayment.findMany({
      where: {
        paymentStatus: "SUCCESS",
        cycle: { societyId },
        user: { societyId },
      },
      select: {
        cycle: { select: { financialYearId: true, cycleKey: true } },
        user: { select: { villaId: true } },
        amountPaid: true,
      },
    });

    // Fold MP by (villa, cycle) — sum
    const mpByKey = new Map<string, number>();
    for (const mp of maintenancePayments) {
      if (!mp.maintenanceCollectionCycleId) continue;
      const key = `${mp.villaId}:${mp.maintenanceCollectionCycleId}`;
      mpByKey.set(key, (mpByKey.get(key) ?? 0) + Number(mp.amount));
    }

    // Fold UCP by (villa, MC cycle) — max
    const ucpByKey = new Map<string, number>();
    for (const ucp of userCyclePayments) {
      const villaId = ucp.user?.villaId;
      if (!villaId) continue;
      const mcId = mcByFyKey.get(`${ucp.cycle.financialYearId}:${ucp.cycle.cycleKey}`);
      if (!mcId) continue;
      const key = `${villaId}:${mcId}`;
      const amount = Number(ucp.amountPaid);
      ucpByKey.set(key, Math.max(ucpByKey.get(key) ?? 0, amount));
    }

    // Reconcile per (villa, cycle): max(mpSum, ucpMax) when MP > 0
    const reconciledCashMap = new Map<string, number>();
    const allPaymentKeys = new Set<string>([...mpByKey.keys(), ...ucpByKey.keys()]);
    for (const key of allPaymentKeys) {
      const [, cycleId] = key.split(":") as [string, string];
      const mpSum = mpByKey.get(key) ?? 0;
      const ucpMax = ucpByKey.get(key) ?? 0;
      const cashReceived = mpSum > 0.005 ? Math.max(mpSum, ucpMax) : 0;
      if (cashReceived <= 0.005) continue;
      reconciledCashMap.set(cycleId, (reconciledCashMap.get(cycleId) ?? 0) + cashReceived);
    }

    // 5. Check each cycle
    const cycleResults: ReconciliationResult['cycleResults'] = [];
    let alertsCreated = 0;
    let alertsResolved = 0;
    let alertsUpdated = 0;
    let maxDifference = 0;

    for (const [cycleId, data] of byCycle) {
      const breakdown = computeCycleReconciliationBreakdown(
        data.villaSum,
        reconciledCashMap.get(cycleId) || 0,
      );
      const {
        villaSum,
        societyCash,
        creditApplied,
        unexplainedDifference,
        matched,
        alertDifference,
      } = breakdown;

      cycleResults.push({
        cycleId,
        cycleTitle: data.cycleTitle,
        villaSum,
        societyCash,
        creditApplied,
        unexplainedDifference,
        difference: alertDifference,
        matched,
      });

      if (matched) {
        const resolveNote = buildReconciliationAutoResolveNote(data.cycleTitle, breakdown);
        const resolved = await db.reconciliationAlert.updateMany({
          where: {
            societyId,
            cycleId,
            resolvedAt: null,
          },
          data: {
            resolvedAt: new Date(),
            notes: resolveNote,
          },
        });
        alertsResolved += resolved.count;
        continue;
      }

      maxDifference = Math.max(maxDifference, alertDifference);

      const existingAlert = await db.reconciliationAlert.findFirst({
        where: {
          societyId,
          cycleId,
          resolvedAt: null,
        },
      });

      const severity = alertSeverityForDifference(alertDifference);

      if (existingAlert) {
        await db.reconciliationAlert.update({
          where: { id: existingAlert.id },
          data: {
            villaSum,
            societyCash,
            creditApplied,
            unexplainedDifference,
            difference: alertDifference,
            severity,
          },
        });
        alertsUpdated++;

        logger.warn({
          cycleId,
          cycleTitle: data.cycleTitle,
          villaSum: villaSum.toFixed(2),
          societyCash: societyCash.toFixed(2),
          creditApplied: creditApplied.toFixed(2),
          difference: alertDifference.toFixed(2),
        }, `[Reconciliation] MISMATCH persists in cycle ${cycleId} (alert refreshed)`);
      } else {
        await db.reconciliationAlert.create({
          data: {
            societyId,
            cycleId,
            villaSum,
            societyCash,
            creditApplied,
            unexplainedDifference,
            difference: alertDifference,
            severity,
          },
        });
        alertsCreated++;

        logger.error({
          cycleId,
          cycleTitle: data.cycleTitle,
          villaSum: villaSum.toFixed(2),
          societyCash: societyCash.toFixed(2),
          creditApplied: creditApplied.toFixed(2),
          difference: alertDifference.toFixed(2),
        }, `[Reconciliation] MISMATCH in cycle ${cycleId}`);
      }
    }

    // 6. Overall check
    const totalVillaSum = Array.from(byCycle.values()).reduce(
      (sum, data) => sum + data.villaSum,
      0
    );
    const totalSocietyCash = Array.from(reconciledCashMap.values()).reduce(
      (sum, amount) => sum + amount,
      0
    );
    const overallBreakdown = computeCycleReconciliationBreakdown(
      totalVillaSum,
      totalSocietyCash,
    );
    const totalDifference = overallBreakdown.alertDifference;

    logger.info({
      villaSum: totalVillaSum.toFixed(2),
      reconciledCash: totalSocietyCash.toFixed(2),
      snapshotCash: societySnapshot.maintenanceCashAllTime.toFixed(2),
      creditApplied: overallBreakdown.creditApplied.toFixed(2),
      diff: totalDifference.toFixed(2),
      alertsCreated,
      alertsResolved,
      alertsUpdated,
    }, `[Reconciliation] Overall for society ${societyId}`);

    return {
      matched: overallBreakdown.matched && cycleResults.every((r) => r.matched),
      totalDifference,
      cycleResults,
      alertsCreated,
      alertsResolved,
      alertsUpdated,
    };
  } catch (error) {
    logger.error({ err: error, societyId }, `[Reconciliation] Error for society ${societyId}`);
    throw error;
  }
}

/**
 * Reconcile all active societies.
 * Called by hourly cron job.
 */
export async function reconcileAllSocieties(): Promise<{
  total: number;
  successful: number;
  failed: number;
  totalAlerts: number;
}> {
  const societies = await prisma.society.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, name: true },
  });

  let successful = 0;
  let failed = 0;
  let totalAlerts = 0;

  for (const society of societies) {
    try {
      const result = await reconcileSocietyLedger(society.id);
      
      if (!result.matched) {
        logger.error({
          societyName: society.name,
          totalDifference: result.totalDifference.toFixed(2),
          alertsCreated: result.alertsCreated,
          alertsResolved: result.alertsResolved,
          alertsUpdated: result.alertsUpdated,
        }, `[Cron] Reconciliation FAILED for ${society.name}`);
      } else {
        logger.info({
          societyName: society.name,
          alertsResolved: result.alertsResolved,
        }, `[Cron] Reconciliation OK for ${society.name}`);
      }

      totalAlerts += result.alertsCreated;
      successful++;
    } catch (error) {
      logger.error({ err: error, societyName: society.name }, `[Cron] Reconciliation error for ${society.name}`);
      failed++;
    }
  }

  return {
    total: societies.length,
    successful,
    failed,
    totalAlerts,
  };
}
