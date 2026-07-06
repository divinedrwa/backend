/**
 * Repair phantom "Billing cash sync" MaintenancePayment rows created by the
 * credit-as-cash double-count bug.
 *
 * The bug (fixed in code): reconcileVillaLedgerFromUserCyclePayment trusted
 * UserCyclePayment.amountPaid as pure cash, but that value included advance
 * credit applied at gateway checkout. It therefore back-filled the credit
 * portion as a new CASH MaintenancePayment row ("Billing cash sync: …"),
 * double-counting the villa's credit and inflating the society fund by the
 * same amount.
 *
 * How this decides what to remove (SAFE):
 *   A "Billing cash sync" row is treated as PHANTOM only if removing it does
 *   NOT underpay any cycle — i.e. the villa's real cash + genuine advance
 *   credit (from actual overpayments) still fully settles every cycle that is
 *   currently settled. If removing a sync row would leave a cycle underpaid,
 *   that row was covering genuinely missing gateway cash and is KEPT (flagged
 *   AMBIGUOUS for manual review against payment-gateway/bank records).
 *
 * DRY-RUN by default — prints the plan and changes NOTHING. Pass --apply to
 * delete the confirmed-phantom rows and re-run the (fixed) credit walker so
 * snapshots/credit reflect the corrected cash ledger. Review the dry-run
 * against your gateway dashboard before applying.
 *
 * Usage:
 *   cd backend
 *   npx tsx scripts/repair-phantom-credit-cash.ts [--society <id>] [--apply]
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import {
  advanceCreditWalkStep,
  refreshSnapshotStatus,
} from "../src/modules/maintenance-management/snapshot-helpers";
import {
  loadCreditWalkBillingContext,
  resolveWalkExpectedForCycle,
} from "../src/modules/maintenance-management/credit-walk-billing-context";
import { applyVillaCreditAcrossSnapshots } from "../src/modules/maintenance-management/credit-walker";

type Args = { societyId?: string; apply: boolean };

function parseArgs(): Args {
  const out: Args = { apply: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--society") {
      const v = argv[++i];
      if (!v) throw new Error("--society requires an id");
      out.societyId = v;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: tsx scripts/repair-phantom-credit-cash.ts [--society <id>] [--apply]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const SYNC_REMARK_PREFIX = "Billing cash sync";
const round2 = (n: number) => Math.round(n * 100) / 100;
const isPaidLike = (s: string) => s === "PAID" || s === "WAIVED";

type SyncRow = { id: string; cycleId: string; periodKey: string; amount: number };
type VillaPlan = {
  societyId: string;
  societyName: string;
  villaId: string;
  villaNumber: string | null;
  phantomRows: SyncRow[];
  phantomCash: number; // society-fund over-count to remove
  creditBefore: number;
  creditAfter: number;
  ambiguous: boolean;
  regressCycles: string[]; // cycles that would underpay if sync rows removed
};

/** Walk a villa with a given per-cycle cash map; return final pool + per-cycle applied/status. */
function walkVilla(
  cycles: {
    id: string;
    financialYearId: string;
    periodKey: string;
    dueDate: Date;
    periodMonth: number;
    periodYear: number;
  }[],
  snapByCycle: Map<string, { expectedAmount: unknown; lateFeeAmount: unknown; lateFeeAppliedAt: Date | null; paidAmount: unknown; status: string }>,
  billingCtx: Awaited<ReturnType<typeof loadCreditWalkBillingContext>>,
  cashByCycle: Map<string, number>,
  unlinkedByPeriod: Map<string, number>,
  nowUtc: Date,
): { pool: number; status: Map<string, string>; applied: Map<string, number> } {
  let pool = 0;
  const status = new Map<string, string>();
  const applied = new Map<string, number>();
  for (const c of cycles) {
    pool += unlinkedByPeriod.get(`${c.periodMonth}:${c.periodYear}`) ?? 0;
    const snap = snapByCycle.get(c.id);
    if (!snap) continue;
    if (snap.status === "WAIVED") {
      status.set(c.id, "WAIVED");
      continue;
    }
    const expected = resolveWalkExpectedForCycle(billingCtx, c, snap, nowUtc);
    const cash = cashByCycle.get(c.id) ?? 0;
    const step = advanceCreditWalkStep(expected, cash, pool);
    pool = step.creditPool;
    applied.set(c.id, step.applied);
    status.set(c.id, refreshSnapshotStatus(expected, step.applied, c.dueDate));
  }
  return { pool, status, applied };
}

async function planSociety(societyId: string, societyName: string): Promise<VillaPlan[]> {
  const nowUtc = new Date();
  const cycles = await prisma.maintenanceCollectionCycle.findMany({
    where: { societyId },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: { id: true, financialYearId: true, periodKey: true, dueDate: true, periodMonth: true, periodYear: true },
  });
  if (cycles.length === 0) return [];
  const cycleIds = cycles.map((c) => c.id);
  const periodByCycle = new Map(cycles.map((c) => [c.id, c.periodKey]));

  const [snapshots, payments, villas] = await Promise.all([
    prisma.villaMaintenanceSnapshot.findMany({
      where: { cycleId: { in: cycleIds } },
      select: { villaId: true, cycleId: true, expectedAmount: true, lateFeeAmount: true, lateFeeAppliedAt: true, paidAmount: true, status: true },
    }),
    prisma.maintenancePayment.findMany({
      where: { societyId, villaId: { not: undefined } },
      select: { id: true, villaId: true, maintenanceCollectionCycleId: true, month: true, year: true, amount: true, remarks: true },
    }),
    prisma.villa.findMany({ where: { societyId }, select: { id: true, villaNumber: true } }),
  ]);

  const villaNumber = new Map(villas.map((v) => [v.id, v.villaNumber]));
  const snapsByVilla = new Map<string, Map<string, (typeof snapshots)[number]>>();
  for (const s of snapshots) {
    let m = snapsByVilla.get(s.villaId);
    if (!m) snapsByVilla.set(s.villaId, (m = new Map()));
    m.set(s.cycleId, s);
  }
  const villaIds = [...snapsByVilla.keys()];
  const billingCtx = await loadCreditWalkBillingContext(prisma, societyId, villaIds);

  // Group payments per villa, splitting phantom-sync candidates from real cash.
  type Agg = {
    allLinked: Map<string, number>;
    cleanLinked: Map<string, number>;
    allUnlinked: Map<string, number>;
    cleanUnlinked: Map<string, number>;
    syncRows: SyncRow[];
  };
  const byVilla = new Map<string, Agg>();
  const getAgg = (v: string): Agg => {
    let a = byVilla.get(v);
    if (!a) {
      a = { allLinked: new Map(), cleanLinked: new Map(), allUnlinked: new Map(), cleanUnlinked: new Map(), syncRows: [] };
      byVilla.set(v, a);
    }
    return a;
  };
  for (const p of payments) {
    const a = getAgg(p.villaId);
    const amt = Number(p.amount);
    const isSync = (p.remarks ?? "").startsWith(SYNC_REMARK_PREFIX);
    if (p.maintenanceCollectionCycleId) {
      const cid = p.maintenanceCollectionCycleId;
      a.allLinked.set(cid, (a.allLinked.get(cid) ?? 0) + amt);
      if (!isSync) a.cleanLinked.set(cid, (a.cleanLinked.get(cid) ?? 0) + amt);
      if (isSync) a.syncRows.push({ id: p.id, cycleId: cid, periodKey: periodByCycle.get(cid) ?? cid, amount: amt });
    } else {
      const k = `${p.month}:${p.year}`;
      a.allUnlinked.set(k, (a.allUnlinked.get(k) ?? 0) + amt);
      if (!isSync) a.cleanUnlinked.set(k, (a.cleanUnlinked.get(k) ?? 0) + amt);
    }
  }

  const plans: VillaPlan[] = [];
  for (const [villaId, snaps] of snapsByVilla) {
    const a = byVilla.get(villaId);
    if (!a || a.syncRows.length === 0) continue; // no sync rows → nothing to repair

    const now = walkVilla(cycles, snaps, billingCtx, a.allLinked, a.allUnlinked, nowUtc);
    const clean = walkVilla(cycles, snaps, billingCtx, a.cleanLinked, a.cleanUnlinked, nowUtc);

    // Regression = a cycle currently settled that would become underpaid once
    // the sync rows are removed → those sync rows are genuine cash, not phantom.
    const regressCycles: string[] = [];
    for (const c of cycles) {
      const stored = snaps.get(c.id)?.status;
      if (!stored || !isPaidLike(stored)) continue;
      const cleanStatus = clean.status.get(c.id);
      if (cleanStatus && !isPaidLike(cleanStatus)) regressCycles.push(c.periodKey);
    }

    const ambiguous = regressCycles.length > 0;
    plans.push({
      societyId,
      societyName,
      villaId,
      villaNumber: villaNumber.get(villaId) ?? null,
      phantomRows: a.syncRows,
      phantomCash: round2(a.syncRows.reduce((s, r) => s + r.amount, 0)),
      creditBefore: round2(now.pool),
      creditAfter: round2(clean.pool),
      ambiguous,
      regressCycles,
    });
  }
  plans.sort((x, y) => y.phantomCash - x.phantomCash);
  return plans;
}

async function main() {
  const args = parseArgs();
  const societies = await prisma.society.findMany({
    where: { archivedAt: null, ...(args.societyId ? { id: args.societyId } : {}) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  if (societies.length === 0) {
    console.error("No matching active societies.");
    process.exit(1);
  }

  const all: VillaPlan[] = [];
  for (const s of societies) all.push(...(await planSociety(s.id, s.name)));

  const removable = all.filter((p) => !p.ambiguous);
  const ambiguous = all.filter((p) => p.ambiguous);

  if (all.length === 0) {
    console.log("\n✅ No 'Billing cash sync' rows found. Nothing to repair.\n");
    await prisma.$disconnect();
    process.exit(0);
  }

  console.log(`\n${args.apply ? "APPLYING" : "DRY-RUN"} phantom credit-as-cash repair\n${"─".repeat(60)}`);
  let lastSoc = "";
  for (const p of all) {
    if (p.societyName !== lastSoc) {
      console.log(`\n=== ${p.societyName} (${p.societyId}) ===`);
      lastSoc = p.societyName;
    }
    const tag = p.ambiguous ? "⚠️  AMBIGUOUS — genuine cash, review manually" : "PHANTOM — safe to remove";
    console.log(
      `\n  Villa ${p.villaNumber ?? p.villaId}  [${tag}]\n` +
        `    sync rows: ${p.phantomRows.map((r) => `${r.periodKey}=₹${r.amount.toFixed(2)}`).join(", ")}\n` +
        `    fund over-count if removed: ₹${p.phantomCash.toFixed(2)}\n` +
        `    credit pool: ₹${p.creditBefore.toFixed(2)} → ₹${p.creditAfter.toFixed(2)}` +
        (p.ambiguous ? `\n    ⛔ would underpay cycles: ${p.regressCycles.join(", ")} (KEEP these rows)` : ""),
    );
  }

  const totalPhantomCash = round2(removable.reduce((s, p) => s + p.phantomCash, 0));
  console.log(
    `\n${"─".repeat(60)}\n` +
      `Villas with sync rows: ${all.length}\n` +
      `  safe-to-remove (phantom): ${removable.length}  |  fund over-count: ₹${totalPhantomCash.toFixed(2)}\n` +
      `  ambiguous (kept for review): ${ambiguous.length}\n`,
  );

  if (!args.apply) {
    console.log(
      "DRY-RUN — nothing changed. Review the phantom rows above against your\n" +
        "gateway/bank records, then re-run with --apply to delete them and re-walk.\n",
    );
    await prisma.$disconnect();
    process.exit(0);
  }

  // --apply: delete confirmed-phantom rows and re-run the fixed walker per villa.
  let deleted = 0;
  for (const p of removable) {
    // Generous timeout: the re-walk runs several queries per FY and Neon adds
    // network latency — well over the 5s interactive-transaction default.
    await prisma.$transaction(
      async (tx) => {
        const ids = p.phantomRows.map((r) => r.id);
        const del = await tx.maintenancePayment.deleteMany({ where: { id: { in: ids }, societyId: p.societyId } });
        deleted += del.count;
        // Re-derive snapshots/credit per FY touched.
        const fys = await tx.financialYear.findMany({ where: { societyId: p.societyId }, select: { id: true } });
        for (const fy of fys) {
          await applyVillaCreditAcrossSnapshots(tx, {
            societyId: p.societyId,
            villaId: p.villaId,
            financialYearId: fy.id,
          });
        }
      },
      { timeout: 60000, maxWait: 20000 },
    );
    console.log(`  ✓ villa ${p.villaNumber ?? p.villaId}: removed ${p.phantomRows.length} row(s), re-walked`);
  }
  console.log(`\n✅ Applied. Deleted ${deleted} phantom row(s) across ${removable.length} villa(s).\n`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
