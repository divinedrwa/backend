/**
 * Quick diagnostic: checks if any MaintenancePayment rows are missing
 * maintenanceCollectionCycleId (unlinked to billing cycles, invisible
 * to the credit-walker) and shows villas that overpaid.
 *
 * Usage: npx tsx scripts/check-credit.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // 1. Count total payments vs unlinked payments
  const totalPayments = await prisma.maintenancePayment.count();
  const unlinkedPayments = await prisma.maintenancePayment.count({
    where: { maintenanceCollectionCycleId: null },
  });

  console.log(`\n--- MaintenancePayment diagnostic ---`);
  console.log(`Total payments:    ${totalPayments}`);
  console.log(`Linked to cycle:   ${totalPayments - unlinkedPayments}`);
  console.log(`Unlinked (legacy): ${unlinkedPayments}`);

  if (unlinkedPayments > 0) {
    console.log(
      `\n⚠  ${unlinkedPayments} payment(s) have NO maintenanceCollectionCycleId.`
    );
    console.log(
      `   These are invisible to the credit-walker and won't generate advance credit.`
    );

    // Show details of unlinked payments
    const unlinked = await prisma.maintenancePayment.findMany({
      where: { maintenanceCollectionCycleId: null },
      select: {
        id: true,
        villaId: true,
        month: true,
        year: true,
        amount: true,
        paymentMode: true,
        remarks: true,
        villa: { select: { villaNumber: true, ownerName: true } },
      },
      orderBy: [{ year: "asc" }, { month: "asc" }],
    });

    console.log(`\nUnlinked payment details:`);
    for (const p of unlinked) {
      console.log(
        `  Villa ${p.villa.villaNumber} (${p.villa.ownerName}): ` +
          `₹${Number(p.amount)} for ${p.month}/${p.year} ` +
          `[${p.paymentMode}] ${p.remarks ?? ""}`
      );
    }
  }

  // 2. Check for overpayments in linked payments
  const snapshots = await prisma.villaMaintenanceSnapshot.findMany({
    select: {
      villaId: true,
      cycleId: true,
      expectedAmount: true,
      paidAmount: true,
      status: true,
      villa: { select: { villaNumber: true, ownerName: true } },
    },
  });

  const linkedCash = await prisma.maintenancePayment.groupBy({
    by: ["villaId", "maintenanceCollectionCycleId"],
    where: { maintenanceCollectionCycleId: { not: null } },
    _sum: { amount: true },
  });

  const cashMap = new Map<string, number>();
  for (const row of linkedCash) {
    if (row.maintenanceCollectionCycleId) {
      const key = `${row.villaId}|${row.maintenanceCollectionCycleId}`;
      cashMap.set(key, Number(row._sum.amount ?? 0));
    }
  }

  console.log(`\n--- Overpayment check (linked payments) ---`);
  let foundOverpay = false;
  for (const s of snapshots) {
    const key = `${s.villaId}|${s.cycleId}`;
    const cash = cashMap.get(key) ?? 0;
    const expected = Number(s.expectedAmount);
    if (cash > expected + 0.01) {
      foundOverpay = true;
      console.log(
        `  Villa ${s.villa.villaNumber}: paid ₹${cash} vs expected ₹${expected} ` +
          `(excess ₹${(cash - expected).toFixed(0)}) [${s.status}]`
      );
    }
  }
  if (!foundOverpay) {
    console.log(`  No overpayments found in linked payments.`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
