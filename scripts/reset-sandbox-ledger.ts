#!/usr/bin/env npx tsx
/**
 * Reset payment + reconciliation test data for qa-sandbox-society only (J1).
 * Safe: refuses non-sandbox societies.
 *
 * Usage (local, after guard:local-db):
 *   npm run reset:sandbox-ledger
 */
import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { isSandboxSociety } from "../src/lib/sandboxSociety";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const prisma = new PrismaClient();
const SOCIETY_ID = "qa-sandbox-society";

async function main(): Promise<void> {
  const society = await prisma.society.findUnique({
    where: { id: SOCIETY_ID },
    select: { id: true, name: true, isSandbox: true },
  });

  if (!society) {
    console.error(`❌ Society ${SOCIETY_ID} not found. Run: npm run prisma:seed-sandbox`);
    process.exit(1);
  }

  if (!(await isSandboxSociety(SOCIETY_ID))) {
    console.error("❌ Refusing reset — society is not marked isSandbox=true.");
    process.exit(1);
  }

  console.log(`🧹 Resetting sandbox ledger for ${society.name}…`);

  const cycles = await prisma.maintenanceCollectionCycle.findMany({
    where: { societyId: SOCIETY_ID },
    select: { id: true },
  });
  const cycleIds = cycles.map((c) => c.id);

  const deletedPayments = await prisma.maintenancePayment.deleteMany({
    where: { cycleId: { in: cycleIds } },
  });

  const resetSnapshots = await prisma.villaMaintenanceSnapshot.updateMany({
    where: { cycleId: { in: cycleIds } },
    data: {
      paidAmount: 0,
      status: "PENDING",
    },
  });

  const deletedAlerts = await prisma.reconciliationAlert.deleteMany({
    where: { societyId: SOCIETY_ID },
  });

  const deletedLogs = await prisma.billingPaymentLog.deleteMany({
    where: { societyId: SOCIETY_ID },
  });

  console.log("✅ Sandbox ledger reset complete");
  console.log(`   maintenance payments removed: ${deletedPayments.count}`);
  console.log(`   villa snapshots reset: ${resetSnapshots.count}`);
  console.log(`   reconciliation alerts removed: ${deletedAlerts.count}`);
  console.log(`   billing payment logs removed: ${deletedLogs.count}`);
  console.log("");
  console.log("   Re-seed maintenance fixture: npm run prisma:seed-sandbox-maintenance");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
