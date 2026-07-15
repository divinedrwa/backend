/**
 * One-off diagnostic: explain reconciliation alerts per cycle.
 * Run: npx tsx scripts/diagnose-reconciliation.ts
 */
import { PrismaClient } from "@prisma/client";
import { reconcileSocietyLedger } from "../src/lib/reconciliation";

const prisma = new PrismaClient();

async function diagnoseCycle(societyId: string, cycleId: string, cycleTitle: string) {
  const snapshots = await prisma.villaMaintenanceSnapshot.findMany({
    where: { cycleId },
    include: { villa: { select: { villaNumber: true, block: true } } },
  });

  const villaSum = snapshots.reduce((s, x) => s + Number(x.paidAmount), 0);

  const mps = await prisma.maintenancePayment.findMany({
    where: { societyId, maintenanceCollectionCycleId: cycleId },
    select: { villaId: true, amount: true, paymentDate: true, paymentMode: true, remarks: true },
  });

  const mpSumByVilla = new Map<string, number>();
  for (const mp of mps) {
    mpSumByVilla.set(mp.villaId, (mpSumByVilla.get(mp.villaId) ?? 0) + Number(mp.amount));
  }
  const mpTotal = [...mpSumByVilla.values()].reduce((a, b) => a + b, 0);

  const cycle = await prisma.maintenanceCollectionCycle.findUnique({
    where: { id: cycleId },
    select: { financialYearId: true, periodKey: true },
  });

  const ucps = cycle
    ? await prisma.userCyclePayment.findMany({
        where: {
          paymentStatus: "SUCCESS",
          cycle: { societyId, financialYearId: cycle.financialYearId, cycleKey: cycle.periodKey },
          user: { societyId, villaId: { not: null } },
        },
        select: {
          amountPaid: true,
          user: { select: { villaId: true, name: true } },
        },
      })
    : [];

  const ucpMaxByVilla = new Map<string, number>();
  for (const u of ucps) {
    const vid = u.user?.villaId;
    if (!vid) continue;
    ucpMaxByVilla.set(vid, Math.max(ucpMaxByVilla.get(vid) ?? 0, Number(u.amountPaid)));
  }

  let reconciledCash = 0;
  const allVillas = new Set([...mpSumByVilla.keys(), ...ucpMaxByVilla.keys(), ...snapshots.map((s) => s.villaId)]);
  const mismatches: Array<{
    villa: string;
    snapPaid: number;
    mpSum: number;
    ucpMax: number;
    cashUsed: number;
  }> = [];

  for (const villaId of allVillas) {
    const snap = snapshots.find((s) => s.villaId === villaId);
    const mpSum = mpSumByVilla.get(villaId) ?? 0;
    const ucpMax = ucpMaxByVilla.get(villaId) ?? 0;
    const cashUsed = mpSum > 0.005 ? Math.max(mpSum, ucpMax) : 0;
    reconciledCash += cashUsed;
    const snapPaid = snap ? Number(snap.paidAmount) : 0;
    if (Math.abs(snapPaid - cashUsed) > 0.01 || Math.abs(snapPaid - mpSum) > 0.01) {
      const v = snap?.villa;
      const label = v ? `${v.block ?? ""}-${v.villaNumber}`.replace(/^-/, "") : villaId.slice(0, 8);
      mismatches.push({ villa: label, snapPaid, mpSum, ucpMax, cashUsed });
    }
  }

  console.log("\n===", cycleTitle, "===");
  console.log("villaSum (snapshots):", villaSum.toFixed(2));
  console.log("societyCash (reconciled):", reconciledCash.toFixed(2));
  console.log("MP total (raw sum):", mpTotal.toFixed(2));
  console.log("difference:", Math.abs(villaSum - reconciledCash).toFixed(2));
  console.log("villas with per-villa drift:", mismatches.length);
  for (const m of mismatches.slice(0, 15)) {
    console.log(
      `  ${m.villa}: snap=${m.snapPaid} mp=${m.mpSum} ucp=${m.ucpMax} cashUsed=${m.cashUsed}`,
    );
  }
  if (mismatches.length > 15) console.log(`  ... +${mismatches.length - 15} more`);
}

async function main() {
  const alerts = await prisma.reconciliationAlert.findMany({
    where: { resolvedAt: null },
    include: {
      society: { select: { id: true, name: true } },
      cycle: { select: { id: true, title: true } },
    },
    orderBy: { difference: "desc" },
  });

  console.log("Unresolved alerts:", alerts.length);
  for (const a of alerts) {
    console.log(
      `- [${a.severity}] ${a.society.name} / ${a.cycle?.title}: villas=${a.villaSum} cash=${a.societyCash} diff=${a.difference}`,
    );
  }

  if (alerts.length === 0) return;

  const societyId = alerts[0].society.id;
  console.log("\n--- Live reconcile run ---");
  const live = await reconcileSocietyLedger(societyId);
  console.log("matched:", live.matched, "alertsCreated:", live.alertsCreated);
  for (const r of live.cycleResults.filter((c) => !c.matched)) {
    console.log(
      `  MISMATCH ${r.cycleTitle}: villa=${r.villaSum.toFixed(2)} cash=${r.societyCash.toFixed(2)} diff=${r.difference.toFixed(2)}`,
    );
  }

  const seen = new Set<string>();
  for (const a of alerts) {
    if (!a.cycleId || seen.has(a.cycleId)) continue;
    seen.add(a.cycleId);
    await diagnoseCycle(a.society.id, a.cycleId, a.cycle?.title ?? a.cycleId);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
