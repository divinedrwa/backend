/**
 * Forensic audit: Villa A-09 (or --villa) full credit walk reconstruction.
 * Run: npx tsx scripts/audit-villa-a09-credits.ts
 */
import { prisma } from "../src/lib/prisma";
import { advanceCreditWalkStep } from "../src/modules/maintenance-management/snapshot-helpers";
import { getVillaCreditBalance } from "../src/modules/maintenance-management/credit-walker";
import { loadCreditWalkBillingContext } from "../src/modules/maintenance-management/credit-walk-billing-context";
import { resolveCreditWalkCycleExpected } from "../src/modules/billing-cycle/domain/amountDue";

const SOCIETY_ID = "cmp32fto40001qout5koygcqu";
const DEFAULT_VILLA = "cmp6hpkaz001jiy2ajutoa9fy"; // A-09

function parseVillaArg(): string {
  const i = process.argv.indexOf("--villa");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : DEFAULT_VILLA;
}

async function main() {
  const villaId = parseVillaArg();
  const villa = await prisma.villa.findUnique({
    where: { id: villaId },
    select: { villaNumber: true, block: true, monthlyMaintenance: true },
  });
  if (!villa) throw new Error("Villa not found");

  const label = `${villa.block}-${villa.villaNumber}`;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`FORENSIC CREDIT AUDIT: ${label} (${villaId})`);
  console.log("=".repeat(70));

  // ALL payments including reversed
  const allPayments = await prisma.maintenancePayment.findMany({
    where: { societyId: SOCIETY_ID, villaId },
    orderBy: [{ year: "asc" }, { month: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      amount: true,
      month: true,
      year: true,
      paymentMode: true,
      paymentDate: true,
      maintenanceCollectionCycleId: true,
      remarks: true,
      reversedAt: true,
      reversalOfPaymentId: true,
      createdAt: true,
    },
  });

  console.log("\n--- ALL MaintenancePayment rows (including reversed) ---");
  let cashTotal = 0;
  for (const p of allPayments) {
    const amt = Number(p.amount);
    const rev = p.reversedAt ? " [REVERSED]" : "";
    const link = p.maintenanceCollectionCycleId ? "linked" : "UNLINKED";
    if (!p.reversedAt) cashTotal += amt;
    console.log(
      `  ${p.year}-${String(p.month).padStart(2, "0")} ₹${amt.toFixed(2)} ${p.paymentMode} ${link}${rev}`,
    );
    if (p.remarks) console.log(`    remarks: ${p.remarks}`);
    if (p.reversalOfPaymentId) console.log(`    reversalOf: ${p.reversalOfPaymentId}`);
  }
  console.log(`  → Active (non-reversed) cash total: ₹${cashTotal.toFixed(2)}`);

  // Snapshots
  const snapshots = await prisma.villaMaintenanceSnapshot.findMany({
    where: { villaId },
    include: {
      cycle: {
        select: {
          id: true,
          periodKey: true,
          title: true,
          periodMonth: true,
          periodYear: true,
          status: true,
        },
      },
    },
    orderBy: [{ cycle: { periodYear: "asc" } }, { cycle: { periodMonth: "asc" } }],
  });

  console.log("\n--- VillaMaintenanceSnapshot (DB state) ---");
  let totalExpected = 0;
  let totalSnapPaid = 0;
  for (const s of snapshots) {
    const exp = Number(s.expectedAmount);
    const paid = Number(s.paidAmount);
    totalExpected += exp;
    totalSnapPaid += paid;
    console.log(
      `  ${s.cycle.periodKey} exp ₹${exp} paid ₹${paid} due ₹${Math.max(0, exp - paid)} ${s.status}`,
    );
  }
  console.log(`  → Sum expected: ₹${totalExpected}, sum snapshot paid: ₹${totalSnapPaid}`);
  console.log(`  → Implied surplus (cash - snap settled): ₹${(cashTotal - totalSnapPaid).toFixed(2)}`);

  // Manual re-walk simulation
  const cycles = await prisma.maintenanceCollectionCycle.findMany({
    where: { societyId: SOCIETY_ID },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: {
      id: true,
      periodKey: true,
      periodMonth: true,
      periodYear: true,
      title: true,
      financialYearId: true,
    },
  });

  const billingCtx = await loadCreditWalkBillingContext(prisma, SOCIETY_ID, [villaId]);

  const activePayments = allPayments.filter((p) => !p.reversedAt);
  const cashByCycle = new Map<string, number>();
  const unlinkedByPeriod = new Map<string, number>();

  for (const p of activePayments) {
    const amt = Number(p.amount);
    if (p.maintenanceCollectionCycleId) {
      cashByCycle.set(
        p.maintenanceCollectionCycleId,
        (cashByCycle.get(p.maintenanceCollectionCycleId) ?? 0) + amt,
      );
    } else {
      const key = `${p.year}:${p.month}`;
      unlinkedByPeriod.set(key, (unlinkedByPeriod.get(key) ?? 0) + amt);
    }
  }

  const snapByCycle = new Map(snapshots.map((s) => [s.cycleId, s]));

  console.log("\n--- RE-SIMULATED credit walk (from cash ledger) ---");
  let pool = 0;
  let totalApplied = 0;
  let totalCashInCycles = 0;

  for (const c of cycles) {
    const snap = snapByCycle.get(c.id);
    if (!snap) {
      console.log(`  ${c.periodKey} — NO SNAPSHOT (pool carries ₹${pool.toFixed(2)})`);
      continue;
    }

    const cashThis =
      (cashByCycle.get(c.id) ?? 0) +
      (unlinkedByPeriod.get(`${c.periodYear}:${c.periodMonth}`) ?? 0);
    totalCashInCycles += cashThis;

    if (snap.status === "WAIVED") {
      console.log(`  ${c.periodKey} WAIVED — pool ₹${pool.toFixed(2)} passes through`);
      continue;
    }

    const expected = resolveCreditWalkCycleExpected(
      billingCtx,
      villaId,
      c.id,
      Number(snap.expectedAmount),
      c.periodYear,
      c.periodMonth,
    );

    const step = advanceCreditWalkStep(expected, cashThis, pool);
    pool = step.creditPool;
    totalApplied += step.applied;

    const dbPaid = Number(snap.paidAmount);
    const mismatch = Math.abs(dbPaid - step.applied) > 0.01 ? ` *** DB paid ₹${dbPaid} ≠ walk ₹${step.applied}` : "";
    console.log(
      `  ${c.periodKey} exp ₹${expected} cash ₹${cashThis} → applied ₹${step.applied} pool ₹${pool.toFixed(2)}${mismatch}`,
    );
  }

  const { creditPool } = await getVillaCreditBalance(prisma, { societyId: SOCIETY_ID, villaId });
  console.log(`\n--- SUMMARY ---`);
  console.log(`  Walker credit pool (end): ₹${creditPool.toFixed(2)}`);
  console.log(`  Simulated pool (end):     ₹${pool.toFixed(2)}`);
  console.log(`  Total cash in cycles:     ₹${totalCashInCycles.toFixed(2)}`);
  console.log(`  Total expected (snaps):   ₹${totalExpected.toFixed(2)}`);
  console.log(`  Net advance (cash-exp):   ₹${(cashTotal - totalExpected).toFixed(2)}`);

  // UCP vs MP per cycle for June
  const juneMc = cycles.find((c) => c.periodKey === "2026-06");
  if (juneMc) {
    const mcCash = cashByCycle.get(juneMc.id) ?? 0;
    const juneSnap = snapByCycle.get(juneMc.id);
    console.log(`\n--- June 2026 detail ---`);
    console.log(`  MC cash this cycle: ₹${mcCash}`);
    console.log(`  DB snapshot paid:   ₹${juneSnap ? Number(juneSnap.paidAmount) : 0}`);
    console.log(`  DB status:          ${juneSnap?.status}`);
    console.log(`  Walker would apply: ₹${juneSnap ? advanceCreditWalkStep(Number(juneSnap.expectedAmount), mcCash, pool).applied : "?"}`);
  }

  // Check deleted/manual credit history in remarks
  const manualRows = allPayments.filter(
    (p) =>
      (p.remarks ?? "").toLowerCase().includes("manual") ||
      (p.remarks ?? "").toLowerCase().includes("credit") ||
      (p.remarks ?? "").toLowerCase().includes("adjust"),
  );
  if (manualRows.length) {
    console.log("\n--- Manual/credit/adjust payment rows ---");
    for (const p of manualRows) {
      console.log(
        `  ${p.year}-${p.month} ₹${Number(p.amount)} ${p.reversedAt ? "REVERSED" : "active"} — ${p.remarks}`,
      );
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
