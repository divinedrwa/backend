#!/usr/bin/env npx tsx
/**
 * Local-only charge-head publish trial (qa-sandbox-society).
 * Proves snapshot lines sum to expectedAmount + reconciliation stays clean.
 *
 * Usage: npx tsx scripts/phase4-sandbox-charge-head-local-trial.ts
 */
import path from "path";
import dotenv from "dotenv";
import { BillingCycleStatus, ChargeHeadAmountType, Prisma } from "@prisma/client";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

import { prisma } from "../src/lib/prisma";
import { isSandboxSociety } from "../src/lib/sandboxSociety";
import { reconcileSocietyLedger } from "../src/lib/reconciliation";
import { generateSnapshotsForBillingCycle } from "../src/modules/billing-cycle/billing-collection-link";

const SANDBOX_ID = "qa-sandbox-society";
const TRIAL_KEY = "2099-01";

async function main(): Promise<void> {
  if (!(await isSandboxSociety(SANDBOX_ID))) {
    throw new Error(`Refusing: ${SANDBOX_ID} is not isSandbox=true`);
  }

  console.log("=== Phase 4 local sandbox charge-head trial ===\n");

  await prisma.society.update({
    where: { id: SANDBOX_ID },
    data: { useChargeHeads: true },
  });

  for (const head of [
    { code: "maintenance", label: "Maintenance", fixedAmount: 1000 },
    { code: "sinking", label: "Sinking fund", fixedAmount: 200 },
  ]) {
    await prisma.societyChargeHead.upsert({
      where: {
        societyId_code: { societyId: SANDBOX_ID, code: head.code },
      },
      create: {
        societyId: SANDBOX_ID,
        code: head.code,
        label: head.label,
        amountType: ChargeHeadAmountType.FIXED,
        fixedAmount: new Prisma.Decimal(head.fixedAmount),
        sortOrder: head.code === "maintenance" ? 0 : 1,
        isActive: true,
      },
      update: {
        label: head.label,
        fixedAmount: new Prisma.Decimal(head.fixedAmount),
        isActive: true,
      },
    });
  }

  let fy = await prisma.financialYear.findFirst({
    where: { societyId: SANDBOX_ID },
    orderBy: { startDate: "desc" },
  });
  if (!fy) {
    fy = await prisma.financialYear.create({
      data: {
        societyId: SANDBOX_ID,
        label: "FY 2098-99",
        startDate: new Date("2098-04-01T00:00:00.000Z"),
        endDate: new Date("2099-03-31T23:59:59.000Z"),
      },
    });
  }

  let billingCycle = await prisma.billingCycle.findUnique({
    where: { societyId_cycleKey: { societyId: SANDBOX_ID, cycleKey: TRIAL_KEY } },
  });
  if (!billingCycle) {
    billingCycle = await prisma.billingCycle.create({
      data: {
        societyId: SANDBOX_ID,
        financialYearId: fy.id,
        cycleKey: TRIAL_KEY,
        title: "Phase4 local trial Jan 2099",
        amount: new Prisma.Decimal(1200),
        startDate: new Date("2099-01-01T00:00:00.000Z"),
        endDate: new Date("2099-01-31T00:00:00.000Z"),
        paymentStartDate: new Date("2099-01-01T00:00:00.000Z"),
        paymentEndDate: new Date("2099-01-31T23:59:59.000Z"),
        lateFee: new Prisma.Decimal(0),
        gracePeriodDays: 0,
        status: BillingCycleStatus.OPEN,
        publishedAt: new Date(),
      },
    });
  } else if (!billingCycle.publishedAt) {
    billingCycle = await prisma.billingCycle.update({
      where: { id: billingCycle.id },
      data: { publishedAt: new Date() },
    });
  }

  const villaCount = await prisma.$transaction(async (tx) =>
    generateSnapshotsForBillingCycle(tx, {
      societyId: SANDBOX_ID,
      billingCycleId: billingCycle!.id,
      cycleAmount: 1200,
    }),
  );
  console.log(`Snapshots generated for ${villaCount} villa(s)`);

  const villa = await prisma.villa.findFirst({
    where: { societyId: SANDBOX_ID, villaNumber: "SB-01" },
    select: { id: true },
  });
  if (!villa) throw new Error("SB-01 missing");

  const mc = await prisma.maintenanceCollectionCycle.findFirst({
    where: { societyId: SANDBOX_ID, periodKey: TRIAL_KEY },
  });
  if (!mc) throw new Error("Maintenance cycle missing after publish");

  const snap = await prisma.villaMaintenanceSnapshot.findUnique({
    where: { cycleId_villaId: { cycleId: mc.id, villaId: villa.id } },
    include: { chargeLines: { orderBy: { sortOrder: "asc" } } },
  });
  if (!snap) throw new Error("Villa snapshot missing");

  const lineSum = snap.chargeLines.reduce((s, l) => s + Number(l.amount), 0);
  const expected = Number(snap.expectedAmount);
  const linesOk =
    snap.chargeLines.length >= 2 && Math.abs(lineSum - expected) < 0.02 && expected === 1200;

  console.log(`\nVilla SB-01 snapshot:`);
  console.log(`  expectedAmount=₹${expected}`);
  console.log(`  chargeLines=${snap.chargeLines.length} sum=₹${lineSum}`);
  for (const l of snap.chargeLines) {
    console.log(`    · ${l.label}: ₹${Number(l.amount)}`);
  }

  const recon = await reconcileSocietyLedger(SANDBOX_ID);
  const reconOk = recon.alertsCreated === 0;

  console.log(`\nReconciliation: alertsCreated=${recon.alertsCreated} matched=${recon.matched}`);

  await prisma.society.update({
    where: { id: SANDBOX_ID },
    data: { useChargeHeads: false },
  });

  if (!linesOk || !reconOk) {
    console.error("\nFAIL: charge lines or reconciliation check failed");
    process.exit(1);
  }

  console.log("\nPhase 4 local sandbox charge-head trial: PASS");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
