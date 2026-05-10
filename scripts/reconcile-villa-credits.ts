/**
 * One-shot reconciliation script for the advance-credit dashboard bug.
 *
 * Why this exists:
 *   Before the cash-ledger fix, `MaintenancePayment.amount` was capped at
 *   the cycle's expected amount in the [billing-v1] mark-cash flow, so any
 *   overpayment was missing from the society fund balance — even though
 *   `userCyclePayment.amountPaid` (gateway-acknowledged) had the full
 *   amount. The Residents page reads the user-side ledger so it shows the
 *   correct collected/credit numbers; the dashboard fund balance reads
 *   `MaintenancePayment.aggregate(_sum.amount)` so it under-reports.
 *
 *   This script does two things:
 *     1. Re-runs the credit walker on every villa-FY combination so
 *        snapshots and Maintenance rows reflect the cash ledger plus
 *        chronological credit propagation.
 *     2. Detects per-cycle gaps where `userCyclePayment.amountPaid`
 *        exceeds `sum(MaintenancePayment.amount)` for the same villa+cycle
 *        and (with `--backfill-cash`) writes a back-fill MaintenancePayment
 *        row for the missing surplus so the dashboard balance catches up.
 *
 *   Lost cash that was never written to *either* ledger (e.g. recorded on
 *   paper but never entered into the system) cannot be recovered by this
 *   script. The discrepancy report lists what *can* be back-filled — go
 *   over it against bank statements before running with `--backfill-cash`.
 *
 * What this changes:
 *   - VillaMaintenanceSnapshot.paidAmount and .status (always)
 *   - Maintenance.status (always, in sync with the snapshot)
 *   - MaintenancePayment back-fill rows (only with --backfill-cash)
 *
 * What this does NOT change:
 *   - Existing MaintenancePayment rows (treated as immutable; gaps are
 *     filled by adding new rows tagged with `Reconciliation back-fill` so
 *     they're easy to find later).
 *   - UserCyclePayment.amountPaid (treated as ground truth for cash).
 *
 * How to run:
 *   cd backend
 *   # 1. preview snapshot changes only (no DB writes):
 *   npm run reconcile:villa-credits -- --dry-run
 *   # 2. apply snapshot reconciliation:
 *   npm run reconcile:villa-credits
 *   # 3. preview cash back-fill rows:
 *   npm run reconcile:villa-credits -- --dry-run --backfill-cash
 *   # 4. write the back-fills (only after reviewing the preview):
 *   npm run reconcile:villa-credits -- --backfill-cash
 *
 * Optional flags:
 *   --society <id>     Scope to a single tenant
 *   --dry-run          Print changes but commit nothing
 *   --backfill-cash    Also create back-fill MaintenancePayment rows for
 *                      the userCyclePayment / MaintenancePayment gap
 *
 * Safety:
 *   - Wrapped in a transaction per villa-FY (crash-safe).
 *   - Idempotent for the snapshot pass; the back-fill pass is also
 *     idempotent because gaps disappear after the first run.
 */

import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { applyVillaCreditAcrossSnapshots } from "../src/modules/maintenance-management/credit-walker";
import { prisma } from "../src/lib/prisma";

type Args = { societyId?: string; dryRun: boolean; backfillCash: boolean };

function parseArgs(): Args {
  const out: Args = { dryRun: false, backfillCash: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--backfill-cash") out.backfillCash = true;
    else if (a === "--society") {
      const v = argv[i + 1];
      if (!v) {
        console.error("--society requires an id argument");
        process.exit(2);
      }
      out.societyId = v;
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log(
        `Usage: tsx scripts/reconcile-villa-credits.ts [--society <id>] [--dry-run] [--backfill-cash]`,
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

/**
 * Detect and (optionally) write back-fill MaintenancePayment rows for the
 * (villa, cycle) pairs where userCyclePayment.amountPaid > sum of
 * existing MaintenancePayment.amount.
 *
 * Returns counters so the outer loop can roll up totals.
 */
async function backfillCashGapsForVillaFy(
  tx: Prisma.TransactionClient,
  params: {
    societyId: string;
    villaId: string;
    villaNumber: string;
    financialYearId: string;
    fyLabel: string;
    backfill: boolean;
    log: (line: string) => void;
  },
): Promise<{ gaps: number; backfillAmount: number }> {
  const { societyId, villaId, villaNumber, financialYearId, fyLabel, backfill, log } = params;

  // Cycles for this society & FY (maintenance side and billing side).
  const maintCycles = await tx.maintenanceCollectionCycle.findMany({
    where: { societyId, financialYearId },
    select: {
      id: true,
      periodKey: true,
      periodMonth: true,
      periodYear: true,
      dueDate: true,
    },
  });
  if (maintCycles.length === 0) return { gaps: 0, backfillAmount: 0 };

  const billingCycles = await tx.billingCycle.findMany({
    where: { societyId, financialYearId },
    select: { id: true, cycleKey: true },
  });
  const billingByKey = new Map(billingCycles.map((b) => [b.cycleKey, b.id]));

  // Primary residents of this villa — userCyclePayment is per-user but
  // mirrored across primary residents with the same amount, so we read
  // MAX (not SUM) to avoid double-counting.
  const primaryUsers = await tx.user.findMany({
    where: {
      societyId,
      villaId,
      role: "RESIDENT",
      isActive: true,
      maintenanceBillingRole: "PRIMARY",
    },
    select: { id: true },
  });
  if (primaryUsers.length === 0) return { gaps: 0, backfillAmount: 0 };
  const primaryUserIds = primaryUsers.map((u) => u.id);

  let gaps = 0;
  let backfillAmount = 0;

  for (const mc of maintCycles) {
    const billingCycleId = billingByKey.get(mc.periodKey);
    if (!billingCycleId) continue;

    const [acknowledgedAgg, recordedAgg] = await Promise.all([
      // Max across primary residents = "this cycle was paid this much in
      // cash" per the user-side ledger. Only SUCCESS counts.
      tx.userCyclePayment.findMany({
        where: {
          cycleId: billingCycleId,
          userId: { in: primaryUserIds },
          paymentStatus: "SUCCESS",
        },
        select: { amountPaid: true },
      }),
      tx.maintenancePayment.aggregate({
        where: { villaId, maintenanceCollectionCycleId: mc.id },
        _sum: { amount: true },
      }),
    ]);

    const acknowledgedCash = acknowledgedAgg.reduce(
      (best, row) => Math.max(best, Number(row.amountPaid)),
      0,
    );
    const recordedCash = Number(recordedAgg._sum.amount || 0);
    const gap = Math.round((acknowledgedCash - recordedCash) * 100) / 100;
    if (gap <= 0.005) continue;

    gaps++;
    backfillAmount += gap;
    log(
      `  villa ${villaNumber} fy=${fyLabel} cycle=${mc.periodKey}: ` +
        `acknowledged ₹${acknowledgedCash.toFixed(2)}, recorded ₹${recordedCash.toFixed(2)}, ` +
        `gap ₹${gap.toFixed(2)}` +
        (backfill ? " — back-fill row created" : " — would back-fill"),
    );

    if (backfill) {
      await tx.maintenancePayment.create({
        data: {
          societyId,
          villaId,
          maintenanceCollectionCycleId: mc.id,
          month: mc.periodMonth,
          year: mc.periodYear,
          amount: new Prisma.Decimal(gap),
          paymentDate: new Date(),
          paymentMode: "CASH",
          receiptNumber: `BACKFILL-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
          remarks:
            "Reconciliation back-fill: pre-fix mark-cash capped MaintenancePayment.amount; " +
            "this row restores the surplus that was lost from the society fund balance.",
        },
      });
    }
  }

  return { gaps, backfillAmount };
}

async function main() {
  const args = parseArgs();

  const societies = await prisma.society.findMany({
    where: args.societyId ? { id: args.societyId } : {},
    select: { id: true, name: true, archivedAt: true },
  });

  if (societies.length === 0) {
    console.error("No matching societies found.");
    process.exit(1);
  }

  let changedSnapshots = 0;
  let scannedPairs = 0;
  let totalCashGaps = 0;
  let totalBackfillAmount = 0;

  for (const society of societies) {
    if (society.archivedAt) {
      console.log(`  skip archived society "${society.name}" (${society.id})`);
      continue;
    }
    console.log(`\n[${society.id}] ${society.name}`);

    const fys = await prisma.financialYear.findMany({
      where: { societyId: society.id },
      select: { id: true, label: true },
    });
    const villas = await prisma.villa.findMany({
      where: { societyId: society.id },
      select: { id: true, villaNumber: true },
    });

    for (const fy of fys) {
      for (const villa of villas) {
        scannedPairs++;
        const before = await prisma.villaMaintenanceSnapshot.findMany({
          where: {
            villaId: villa.id,
            cycle: { financialYearId: fy.id, societyId: society.id },
          },
          select: { id: true, status: true, paidAmount: true, cycleId: true },
        });

        const runOnce = async (tx: Prisma.TransactionClient) => {
          // 1. Cash back-fill: detect (and optionally write) MaintenancePayment
          //    rows that close the gap between userCyclePayment.amountPaid
          //    and existing MaintenancePayment.amount. Done before the
          //    snapshot walker so the walker sees the updated cash ledger.
          const cashResult = await backfillCashGapsForVillaFy(tx, {
            societyId: society.id,
            villaId: villa.id,
            villaNumber: villa.villaNumber,
            financialYearId: fy.id,
            fyLabel: fy.label,
            backfill: args.backfillCash,
            log: (line) => console.log(line),
          });
          totalCashGaps += cashResult.gaps;
          totalBackfillAmount += cashResult.backfillAmount;

          // 2. Snapshot reconciliation: re-derive paidAmount/status from the
          //    cash ledger, applying chronological credit propagation.
          await applyVillaCreditAcrossSnapshots(tx, {
            societyId: society.id,
            villaId: villa.id,
            financialYearId: fy.id,
          });
          const after = await tx.villaMaintenanceSnapshot.findMany({
            where: { id: { in: before.map((s) => s.id) } },
            select: { id: true, status: true, paidAmount: true },
          });
          const afterById = new Map(after.map((s) => [s.id, s]));
          for (const b of before) {
            const a = afterById.get(b.id);
            if (!a) continue;
            const paidChanged = Math.abs(Number(a.paidAmount) - Number(b.paidAmount)) >= 0.005;
            const statusChanged = a.status !== b.status;
            if (paidChanged || statusChanged) {
              changedSnapshots++;
              console.log(
                `  villa ${villa.villaNumber} fy=${fy.label} cycleId=${b.cycleId}: ` +
                  `paid ${Number(b.paidAmount).toFixed(2)} → ${Number(a.paidAmount).toFixed(2)}, ` +
                  `status ${b.status} → ${a.status}`,
              );
            }
          }
        };

        if (args.dryRun) {
          try {
            await prisma.$transaction(async (tx) => {
              await runOnce(tx);
              throw new RollbackSentinel();
            });
          } catch (err) {
            if (!(err instanceof RollbackSentinel)) throw err;
          }
        } else {
          await prisma.$transaction(runOnce);
        }
      }
    }
  }

  const verb = args.dryRun ? "would" : "did";
  console.log(
    `\nDone. ${args.dryRun ? "(dry-run) " : ""}` +
      `Scanned ${scannedPairs} villa-FY pairs.\n` +
      `  Snapshots: ${changedSnapshots} ${verb} change.\n` +
      `  Cash gaps: ${totalCashGaps} (villa,cycle) pairs, total ₹${totalBackfillAmount.toFixed(2)} ` +
      `${args.backfillCash ? (args.dryRun ? "would back-fill" : "backfilled") : "detected (re-run with --backfill-cash to apply)"}.`,
  );
}

class RollbackSentinel extends Error {
  constructor() {
    super("dry-run rollback");
    this.name = "RollbackSentinel";
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
