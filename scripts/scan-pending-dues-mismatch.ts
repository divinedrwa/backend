/**
 * Compare snapshot due vs buildPendingDuesFromLedger for all villas.
 * Run: npx tsx scripts/scan-pending-dues-mismatch.ts
 */
import { prisma } from "../src/lib/prisma";
import { buildPendingDuesFromLedger } from "../src/modules/billing-cycle/services/resident-pending-dues";

const SOCIETY_ID = "cmp32fto40001qout5koygcqu";

async function main() {
  const openCycle = await prisma.maintenanceCollectionCycle.findFirst({
    where: { societyId: SOCIETY_ID, periodKey: "2026-06" },
    select: { id: true },
  });
  if (!openCycle) {
    console.log("No June 2026 cycle");
    return;
  }

  const residents = await prisma.user.findMany({
    where: { societyId: SOCIETY_ID, role: "RESIDENT", isActive: true, villaId: { not: null } },
    select: { id: true, name: true, villaId: true, villa: { select: { block: true, villaNumber: true } } },
  });

  const mismatches: string[] = [];

  for (const u of residents) {
    if (!u.villaId || !u.villa) continue;
    const label = u.villa.block + "-" + u.villa.villaNumber;
    const snap = await prisma.villaMaintenanceSnapshot.findUnique({
      where: { cycleId_villaId: { cycleId: openCycle.id, villaId: u.villaId } },
    });
    if (!snap) continue;
    const snapDue = Math.max(0, Number(snap.expectedAmount) - Number(snap.paidAmount));
    const pending = await buildPendingDuesFromLedger(SOCIETY_ID, u.id);
    const junePending = pending.find((p) => p.cycleKey === "2026-06");
    const apiDue = junePending?.remainingDue ?? 0;

    if (Math.abs(snapDue - apiDue) > 0.01) {
      mismatches.push(
        `${label} (${u.name}): snapshot due ₹${snapDue.toFixed(0)} vs API pending ₹${apiDue.toFixed(0)} status ${snap.status}`,
      );
    }
  }

  console.log(`Scanned ${residents.length} residents for June 2026`);
  if (mismatches.length === 0) {
    console.log("No mismatches between snapshot and pendingDues API");
  } else {
    console.log(`\n${mismatches.length} mismatches:`);
    mismatches.forEach((m) => console.log(" ", m));
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
