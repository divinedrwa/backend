/**
 * Live diagnostic: villa credit pool, snapshots, payments.
 * Run: npx tsx scripts/diagnose-villa-credits-live.ts
 */
import { prisma } from "../src/lib/prisma";
import { getVillaCreditBalance } from "../src/modules/maintenance-management/credit-walker";

const SOCIETY_ID = "cmp32fto40001qout5koygcqu";

const VILLAS: Record<string, string> = {
  "A-03": "cmp6hg7ph0001iy2anmics4ko",
  "A-05": "cmp6hpiam000niy2afokumz2x",
  "A-09": "cmp6hpkaz001jiy2ajutoa9fy",
};

async function diagnoseVilla(label: string, villaId: string) {
  const { creditPool: credit } = await getVillaCreditBalance(prisma, { societyId: SOCIETY_ID, villaId });
  console.log(`\n========== ${label} (credit pool: ₹${credit.toFixed(2)}) ==========`);

  const snapshots = await prisma.villaMaintenanceSnapshot.findMany({
    where: { villaId },
    include: {
      cycle: {
        select: {
          title: true,
          periodKey: true,
          periodMonth: true,
          periodYear: true,
          status: true,
        },
      },
    },
    orderBy: [{ cycle: { periodYear: "asc" } }, { cycle: { periodMonth: "asc" } }],
  });

  console.log("Cycle snapshots:");
  for (const s of snapshots) {
    const exp = Number(s.expectedAmount);
    const paid = Number(s.paidAmount);
    const due = Math.max(0, exp - paid);
    console.log(
      `  ${s.cycle.periodKey} | exp ₹${exp} paid ₹${paid} due ₹${due} | ${s.status} | cycle ${s.cycle.status}`,
    );
  }

  const payments = await prisma.maintenancePayment.findMany({
    where: { societyId: SOCIETY_ID, villaId, reversedAt: null },
    orderBy: [{ year: "asc" }, { month: "asc" }, { paymentDate: "asc" }],
    select: {
      amount: true,
      month: true,
      year: true,
      paymentMode: true,
      maintenanceCollectionCycleId: true,
      remarks: true,
    },
  });

  console.log("Payments (non-reversed):");
  for (const p of payments) {
    const pk = `${p.year}-${String(p.month).padStart(2, "0")}`;
    const link = p.maintenanceCollectionCycleId ? "linked" : "UNLINKED";
    console.log(`  ${pk} ₹${Number(p.amount)} ${p.paymentMode} ${link} ${(p.remarks ?? "").slice(0, 50)}`);
  }
}

async function main() {
  for (const [label, villaId] of Object.entries(VILLAS)) {
    await diagnoseVilla(label, villaId);
  }

  // Simulate what resident pending dues might show for June A-09
  const june = await prisma.maintenanceCollectionCycle.findFirst({
    where: { societyId: SOCIETY_ID, periodKey: "2026-06" },
    select: { id: true },
  });
  if (june) {
    const snap = await prisma.villaMaintenanceSnapshot.findFirst({
      where: { cycleId: june.id, villaId: VILLAS["A-09"] },
    });
    if (snap) {
      const mps = await prisma.maintenancePayment.aggregate({
        where: {
          societyId: SOCIETY_ID,
          villaId: VILLAS["A-09"],
          maintenanceCollectionCycleId: june.id,
          reversedAt: null,
        },
        _sum: { amount: true },
      });
      const cash = Number(mps._sum.amount ?? 0);
      const exp = Number(snap.expectedAmount);
      const paid = Number(snap.paidAmount);
      console.log("\n=== A-09 June 2026 due breakdown ===");
      console.log(`expected: ₹${exp}, snapshot paid: ₹${paid}, cash this cycle: ₹${cash}`);
      console.log(`due (exp - paid): ₹${Math.max(0, exp - paid)}`);
      console.log(`due (exp - cash) [buggy pendingDues]: ₹${Math.max(0, exp - cash)}`);
      console.log(`credit applied this cycle: ₹${Math.max(0, paid - cash)}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
