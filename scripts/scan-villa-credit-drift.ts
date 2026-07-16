/**
 * Scan all villas for snapshot vs credit-walk drift.
 * Run: npx tsx scripts/scan-villa-credit-drift.ts [societyId]
 */
import { prisma } from "../src/lib/prisma";
import { findSocietyCreditDrift } from "../src/modules/maintenance-management/credit-walker-drift";
import { applyVillaCreditAcrossSnapshots } from "../src/modules/maintenance-management/credit-walker";

const SOCIETY = process.argv[2] ?? process.env.SOCIETY_ID;
const FIX = process.argv.includes("--fix");

async function main() {
  if (!SOCIETY) {
    console.error("Usage: npx tsx scripts/scan-villa-credit-drift.ts <societyId> [--fix]");
    process.exit(1);
  }

  const drift = await findSocietyCreditDrift(prisma, SOCIETY);
  console.log(`Society ${SOCIETY}: ${drift.length} drift row(s)`);
  for (const row of drift) {
    console.log(
      `  ${row.block}-${row.villaNumber} ${row.title}: snap ${row.snapshotPaid} ${row.snapshotStatus}`,
      `→ walk ${row.expectedPaid} ${row.expectedStatus}`,
      `(cash ${row.cashThis}, credit ${row.creditApplied})`,
    );
  }

  if (FIX && drift.length > 0) {
    const villaIds = [...new Set(drift.map((d) => d.villaId))];
    const fy = await prisma.financialYear.findFirst({
      where: { societyId: SOCIETY, status: "ACTIVE" },
      select: { id: true },
    });
    if (!fy) throw new Error("No active financial year");

    for (const villaId of villaIds) {
      await prisma.$transaction(
        (tx) =>
          applyVillaCreditAcrossSnapshots(tx, {
            societyId: SOCIETY,
            villaId,
            financialYearId: fy.id,
          }),
        { timeout: 60_000 },
      );
    }
    const after = await findSocietyCreditDrift(prisma, SOCIETY);
    console.log(`After --fix: ${after.length} drift row(s)`);
  }

  await prisma.$disconnect();
  process.exit(drift.length > 0 && !FIX ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
