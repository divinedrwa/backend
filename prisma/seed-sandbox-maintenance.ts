/**
 * Minimal maintenance billing for QA sandbox (E2E path #16 / #24).
 * Run after seed-sandbox: npx tsx prisma/seed-sandbox-maintenance.ts
 */
import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const prisma = new PrismaClient();
const SOCIETY_ID = "qa-sandbox-society";

async function main() {
  const society = await prisma.society.findUnique({ where: { id: SOCIETY_ID } });
  if (!society) {
    console.error("Run seed-sandbox first.");
    process.exit(1);
  }

  const villa = await prisma.villa.findFirst({
    where: { societyId: SOCIETY_ID, villaNumber: "SB-01" },
  });
  if (!villa) {
    console.error("Sandbox villa SB-01 missing.");
    process.exit(1);
  }

  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const periodKey = `${y}-${String(m).padStart(2, "0")}`;

  let fy = await prisma.financialYear.findFirst({
    where: { societyId: SOCIETY_ID, label: `FY ${y}-${(y + 1) % 100}` },
  });
  if (!fy) {
    fy = await prisma.financialYear.create({
      data: {
        societyId: SOCIETY_ID,
        label: `FY ${y}-${(y + 1) % 100}`,
        startDate: new Date(Date.UTC(y, 3, 1)),
        endDate: new Date(Date.UTC(y + 1, 2, 31)),
      },
    });
  }

  let cycle = await prisma.maintenanceCollectionCycle.findFirst({
    where: { societyId: SOCIETY_ID, financialYearId: fy.id, periodKey },
  });
  if (!cycle) {
    cycle = await prisma.maintenanceCollectionCycle.create({
      data: {
        societyId: SOCIETY_ID,
        financialYearId: fy.id,
        periodKey,
        title: `Sandbox ${periodKey}`,
        periodMonth: m,
        periodYear: y,
        dueDate: new Date(Date.UTC(y, m - 1, 15)),
        status: "OPEN",
      },
    });
  }

  await prisma.villaMaintenanceSnapshot.upsert({
    where: { cycleId_villaId: { cycleId: cycle.id, villaId: villa.id } },
    create: {
      cycleId: cycle.id,
      villaId: villa.id,
      expectedAmount: villa.monthlyMaintenance ?? 1500,
      paidAmount: 0,
      status: "PENDING",
    },
    update: {
      expectedAmount: villa.monthlyMaintenance ?? 1500,
    },
  });

  console.log("✅ Sandbox maintenance ready");
  console.log(`   FY: ${fy.id}  Cycle: ${cycle.id} (${periodKey})`);
  console.log(`   Villa ${villa.villaNumber}: expected ₹${villa.monthlyMaintenance ?? 1500}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
