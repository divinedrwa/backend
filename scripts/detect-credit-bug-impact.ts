/**
 * READ-ONLY triage: detect villas whose advance credit / paid snapshots were
 * corrupted by the credit-destruction and phantom-late-fee bugs that shipped in
 * the 2026-07-06 "credit related changes" and ran live before the conservation
 * fix (commit 0ff46d7).
 *
 * What the bugs did (all now fixed in code):
 *   - The credit walker DISCARDED the carried-forward advance-credit pool
 *     whenever a cycle was covered by its own cash → residents lost usable
 *     credit; later cycles show more due than they should.
 *   - resolveCreditWalkCycleExpected synthesized a billing late fee from the
 *     clock even for on-time-paid cycles → PAID snapshots flipped to
 *     PARTIAL/OVERDUE and extra credit was consumed for a fee never assessed.
 *
 * How this script works:
 *   The underlying cash ledger (MaintenancePayment) is the source of truth and
 *   was NOT corrupted — only the DERIVED snapshot paidAmount/status and the
 *   credit pool were. So we re-run the FIXED walk logic READ-ONLY (no DB
 *   writes, not even a rollback transaction) and compare the correct result to
 *   what is currently stored. Any divergence = a villa the live bug touched.
 *
 *   For each villa it reports:
 *     - correctCreditPool : advance credit the resident SHOULD have now
 *     - per-cycle diffs    : storedPaid → correctPaid, storedStatus → correctStatus
 *     - a classification   : CREDIT_UNDER_APPLIED (resident over-billed / owed
 *                            credit) or CYCLE_REOPENED (paid cycle shown unpaid)
 *
 * This script changes NOTHING. To HEAL the detected villas, run the fixed
 * walker via:  npm run reconcile:villa-credits            (all villas)
 *              npm run reconcile:villa-credits -- --dry-run   (preview)
 *
 * Usage:
 *   cd backend
 *   npx tsx scripts/detect-credit-bug-impact.ts [--society <id>] [--min <amt>] [--json]
 *     --society <id>  scope to one tenant (default: all active societies)
 *     --min <amt>     only report villas whose |paid delta| ≥ amt (default 0.01)
 *     --json          emit machine-readable JSON instead of the text report
 */
import { prisma } from "../src/lib/prisma";
import {
  advanceCreditWalkStep,
  refreshSnapshotStatus,
} from "../src/modules/maintenance-management/snapshot-helpers";
import {
  loadCreditWalkBillingContext,
  resolveWalkExpectedForCycle,
} from "../src/modules/maintenance-management/credit-walk-billing-context";

type Args = { societyId?: string; min: number; json: boolean };

function parseArgs(): Args {
  const out: Args = { min: 0.01, json: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--society") {
      const v = argv[++i];
      if (!v) throw new Error("--society requires an id");
      out.societyId = v;
    } else if (a === "--min") {
      const v = argv[++i];
      if (!v) throw new Error("--min requires a number");
      out.min = Number(v);
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx scripts/detect-credit-bug-impact.ts [--society <id>] [--min <amt>] [--json]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return out;
}

type CycleDiff = {
  periodKey: string;
  cycleId: string;
  storedPaid: number;
  correctPaid: number;
  storedStatus: string;
  correctStatus: string;
  classification: "CREDIT_UNDER_APPLIED" | "CREDIT_OVER_CONSUMED" | "STATUS_ONLY";
};

type VillaImpact = {
  societyId: string;
  societyName: string;
  villaId: string;
  villaNumber: string | null;
  correctCreditPool: number;
  netPaidDelta: number; // Σ(correctPaid − storedPaid); >0 ⇒ residents under-credited
  cycleReopenedCount: number;
  diffs: CycleDiff[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const eq2 = (a: number, b: number) => Math.abs(a - b) < 0.01;
/** A paid snapshot that the fixed walk still considers paid. */
const isPaidLike = (s: string) => s === "PAID" || s === "WAIVED";

async function scanSociety(
  societyId: string,
  societyName: string,
  minDelta: number,
): Promise<VillaImpact[]> {
  const nowUtc = new Date();

  const cycles = await prisma.maintenanceCollectionCycle.findMany({
    where: { societyId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: {
      id: true,
      financialYearId: true,
      periodKey: true,
      dueDate: true,
      periodMonth: true,
      periodYear: true,
    },
  });
  if (cycles.length === 0) return [];
  const cycleIds = cycles.map((c) => c.id);

  const snapshots = await prisma.villaMaintenanceSnapshot.findMany({
    where: { cycleId: { in: cycleIds } },
    select: {
      villaId: true,
      cycleId: true,
      expectedAmount: true,
      lateFeeAmount: true,
      lateFeeAppliedAt: true,
      paidAmount: true,
      status: true,
    },
  });
  if (snapshots.length === 0) return [];

  const villaIds = [...new Set(snapshots.map((s) => s.villaId))];
  const [billingCtx, cashAgg, unlinkedRows, villas] = await Promise.all([
    loadCreditWalkBillingContext(prisma, societyId, villaIds),
    prisma.maintenancePayment.groupBy({
      by: ["villaId", "maintenanceCollectionCycleId"],
      where: { societyId, maintenanceCollectionCycleId: { in: cycleIds } },
      _sum: { amount: true },
    }),
    prisma.maintenancePayment.groupBy({
      by: ["villaId", "month", "year"],
      where: { societyId, maintenanceCollectionCycleId: null },
      _sum: { amount: true },
    }),
    prisma.villa.findMany({
      where: { societyId, id: { in: villaIds } },
      select: { id: true, villaNumber: true },
    }),
  ]);

  const villaNumber = new Map(villas.map((v) => [v.id, v.villaNumber]));
  const snapsByVilla = new Map<string, Map<string, (typeof snapshots)[number]>>();
  for (const s of snapshots) {
    let m = snapsByVilla.get(s.villaId);
    if (!m) snapsByVilla.set(s.villaId, (m = new Map()));
    m.set(s.cycleId, s);
  }
  const cashKey = (v: string, c: string) => `${v}|${c}`;
  const cashMap = new Map<string, number>();
  for (const r of cashAgg) {
    if (r.maintenanceCollectionCycleId) {
      cashMap.set(cashKey(r.villaId, r.maintenanceCollectionCycleId), Number(r._sum.amount || 0));
    }
  }
  const unlinkedMap = new Map<string, number>();
  for (const r of unlinkedRows) {
    const v = Number(r._sum.amount || 0);
    if (Math.abs(v) > 0.005) unlinkedMap.set(`${r.villaId}:${r.month}:${r.year}`, v);
  }

  const impacts: VillaImpact[] = [];
  for (const [villaId, snaps] of snapsByVilla) {
    let creditPool = 0;
    let netPaidDelta = 0;
    let cycleReopenedCount = 0;
    const diffs: CycleDiff[] = [];

    for (const cycle of cycles) {
      creditPool += unlinkedMap.get(`${villaId}:${cycle.periodMonth}:${cycle.periodYear}`) ?? 0;
      const snap = snaps.get(cycle.id);
      if (!snap) continue;
      if (snap.status === "WAIVED") continue;

      const expected = resolveWalkExpectedForCycle(billingCtx, cycle, snap, nowUtc);
      const cash = cashMap.get(cashKey(villaId, cycle.id)) ?? 0;
      const step = advanceCreditWalkStep(expected, cash, creditPool);
      creditPool = step.creditPool;

      const correctPaid = round2(step.applied);
      const storedPaid = round2(Number(snap.paidAmount));
      const correctStatus = refreshSnapshotStatus(expected, step.applied, cycle.dueDate);
      const storedStatus = snap.status;

      const paidChanged = !eq2(correctPaid, storedPaid);
      const statusChanged = correctStatus !== storedStatus;
      if (!paidChanged && !statusChanged) continue;

      let classification: CycleDiff["classification"] = "STATUS_ONLY";
      if (correctPaid > storedPaid + 0.01) classification = "CREDIT_UNDER_APPLIED";
      else if (correctPaid < storedPaid - 0.01) classification = "CREDIT_OVER_CONSUMED";

      // A cycle the fixed walk considers paid but the DB currently shows unpaid.
      if (isPaidLike(correctStatus) && !isPaidLike(storedStatus)) cycleReopenedCount++;

      netPaidDelta += correctPaid - storedPaid;
      diffs.push({
        periodKey: cycle.periodKey,
        cycleId: cycle.id,
        storedPaid,
        correctPaid,
        storedStatus,
        correctStatus,
        classification,
      });
    }

    const correctCreditPool = round2(creditPool);
    // Report a villa if any snapshot diverges beyond the money threshold, OR a
    // paid cycle was reopened, OR it holds correct credit while the stored
    // snapshots disagree at all.
    const materialMoney = Math.abs(netPaidDelta) >= minDelta;
    if (diffs.length > 0 && (materialMoney || cycleReopenedCount > 0)) {
      impacts.push({
        societyId,
        societyName,
        villaId,
        villaNumber: villaNumber.get(villaId) ?? null,
        correctCreditPool,
        netPaidDelta: round2(netPaidDelta),
        cycleReopenedCount,
        diffs,
      });
    }
  }

  // Worst money impact first.
  impacts.sort((a, b) => Math.abs(b.netPaidDelta) - Math.abs(a.netPaidDelta));
  return impacts;
}

async function main() {
  const args = parseArgs();

  const societies = await prisma.society.findMany({
    where: { archivedAt: null, ...(args.societyId ? { id: args.societyId } : {}) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  if (societies.length === 0) {
    console.error("No matching active societies found.");
    process.exit(1);
  }

  const all: VillaImpact[] = [];
  for (const s of societies) {
    const impacts = await scanSociety(s.id, s.name, args.min);
    all.push(...impacts);
  }

  if (args.json) {
    console.log(JSON.stringify(all, null, 2));
  } else {
    printReport(all, societies.length);
  }
}

function printReport(all: VillaImpact[], societyCount: number): void {
  if (all.length === 0) {
    console.log(
      `\n✅ No affected villas found across ${societyCount} society(ies). ` +
        `Stored snapshots already match the fixed credit logic.\n`,
    );
    return;
  }

  let underCredited = 0;
  let overConsumed = 0;
  let reopened = 0;
  let totalOwedCredit = 0;

  let lastSociety = "";
  for (const v of all) {
    if (v.societyName !== lastSociety) {
      console.log(`\n=== ${v.societyName} (${v.societyId}) ===`);
      lastSociety = v.societyName;
    }
    const tag =
      v.netPaidDelta > 0.01
        ? "⚠️  UNDER-CREDITED (resident over-billed)"
        : v.netPaidDelta < -0.01
          ? "OVER-CONSUMED (extra credit spent)"
          : "STATUS DRIFT";
    console.log(
      `\n  Villa ${v.villaNumber ?? v.villaId}  ${tag}\n` +
        `    correct advance credit now: ₹${v.correctCreditPool.toFixed(2)}\n` +
        `    net paid delta (correct − stored): ₹${v.netPaidDelta.toFixed(2)}` +
        (v.cycleReopenedCount > 0 ? `   |  paid cycles wrongly reopened: ${v.cycleReopenedCount}` : ""),
    );
    for (const d of v.diffs) {
      console.log(
        `      ${d.periodKey}: paid ₹${d.storedPaid.toFixed(2)} → ₹${d.correctPaid.toFixed(2)}, ` +
          `status ${d.storedStatus} → ${d.correctStatus}   [${d.classification}]`,
      );
    }
    if (v.netPaidDelta > 0) underCredited++;
    else if (v.netPaidDelta < 0) overConsumed++;
    if (v.cycleReopenedCount > 0) reopened++;
    if (v.netPaidDelta > 0) totalOwedCredit += v.netPaidDelta;
  }

  console.log(
    `\n${"─".repeat(60)}\n` +
      `Affected villas: ${all.length}\n` +
      `  under-credited (residents over-billed): ${underCredited}\n` +
      `  over-consumed (extra credit spent):      ${overConsumed}\n` +
      `  with paid cycles wrongly reopened:       ${reopened}\n` +
      `  total credit under-applied (owed back):  ₹${totalOwedCredit.toFixed(2)}\n\n` +
      `This report changed nothing. To heal these villas, run the fixed walker:\n` +
      `  npm run reconcile:villa-credits -- --dry-run    # preview\n` +
      `  npm run reconcile:villa-credits                 # apply\n`,
  );
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
