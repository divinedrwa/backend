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
    difference: number;
    matched: boolean;
  }>;
  alertsCreated: number;
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

    // 4. Get society-level cash per cycle from payments
    const societyPaymentsByCycle = await db.maintenancePayment.groupBy({
      by: ['maintenanceCollectionCycleId'],
      where: {
        societyId,
        maintenanceCollectionCycleId: { not: null },
      },
      _sum: { amount: true },
    });

    const societyCashMap = new Map<string, number>();
    for (const group of societyPaymentsByCycle) {
      if (group.maintenanceCollectionCycleId) {
        societyCashMap.set(
          group.maintenanceCollectionCycleId,
          Number(group._sum.amount || 0)
        );
      }
    }

    // 5. Check each cycle
    const cycleResults: ReconciliationResult['cycleResults'] = [];
    let alertsCreated = 0;
    let maxDifference = 0;

    for (const [cycleId, data] of byCycle) {
      const villaSum = data.villaSum;
      const societyCash = societyCashMap.get(cycleId) || 0;
      const difference = Math.abs(villaSum - societyCash);
      const matched = difference <= 0.01; // Allow 1 paisa tolerance

      cycleResults.push({
        cycleId,
        cycleTitle: data.cycleTitle,
        villaSum,
        societyCash,
        difference,
        matched,
      });

      if (!matched) {
        maxDifference = Math.max(maxDifference, difference);

        // Check if alert already exists for this cycle
        const existingAlert = await db.reconciliationAlert.findFirst({
          where: {
            societyId,
            cycleId,
            resolvedAt: null,
          },
        });

        if (!existingAlert) {
          // Create new alert
          await db.reconciliationAlert.create({
            data: {
              societyId,
              cycleId,
              villaSum,
              societyCash,
              difference,
              severity: difference > 1000 ? 'CRITICAL' : 'WARNING',
            },
          });
          alertsCreated++;

          logger.error({
            cycleId,
            cycleTitle: data.cycleTitle,
            villaSum: villaSum.toFixed(2),
            societyCash: societyCash.toFixed(2),
            difference: difference.toFixed(2),
          }, `[Reconciliation] MISMATCH in cycle ${cycleId}`);
        }
      }
    }

    // 6. Overall check
    const totalVillaSum = Array.from(byCycle.values()).reduce(
      (sum, data) => sum + data.villaSum,
      0
    );
    const totalSocietyCash = Array.from(societyCashMap.values()).reduce(
      (sum, amount) => sum + amount,
      0
    );
    const totalDifference = Math.abs(totalVillaSum - totalSocietyCash);
    const overallMatched = totalDifference <= 0.01;

    logger.info(`[Reconciliation] Overall: villa=${totalVillaSum.toFixed(2)}, society=${totalSocietyCash.toFixed(2)}, diff=${totalDifference.toFixed(2)}`);

    return {
      matched: overallMatched && cycleResults.every(r => r.matched),
      totalDifference,
      cycleResults,
      alertsCreated,
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
        }, `[Cron] Reconciliation FAILED for ${society.name}`);
      } else {
        logger.info(`[Cron] Reconciliation OK for ${society.name}`);
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
