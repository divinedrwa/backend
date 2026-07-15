/**
 * Restore Divine Residency Villa A-03 April 2026 to local-verified state:
 * - Real cash: ₹1,180 BANK_TRANSFER (₹80 advance after ₹1,100 applied)
 * - Duplicate ₹1,100 UPI stays reversed (offset pair)
 * - Undo mistaken live "correction" (+₹1,100 re-record) from reconciliation session
 * - Resolve May reconciliation alert with notes only (no payment amount changes)
 *
 * Run: npx tsx scripts/restore-villa-a03-april-local-state.ts
 */
import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { reverseMaintenancePayment, PaymentReversalError } from "../src/lib/reverseMaintenancePayment";
import { applyVillaCreditAcrossSnapshots } from "../src/modules/maintenance-management/credit-walker";
import { syncBillingUserCyclePaymentsFromSnapshot } from "../src/modules/billing-cycle/billing-collection-link";
import { reconcileSocietyLedger } from "../src/lib/reconciliation";
import { invalidateMoneySnapshotCache } from "../src/lib/societyFinance";
import { BillingPaymentSource } from "@prisma/client";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const prisma = new PrismaClient();

const SOCIETY_ID = "cmp32fto40001qout5koygcqu";
const VILLA_ID = "cmp6hg7ph0001iy2anmics4ko";
/** Mistaken +₹1,100 added during live reconciliation session */
const MISTAKEN_1100_ID = "cmrltr7oj0001qoti01pkv76r"; // RCP202604891225 — verify at runtime
const ORIGINAL_BANK_1180_ID = "cmpya4zjf02g3if2aaoz6z2ra";

const MAY_RESOLUTION_NOTES = [
  "Reviewed: manual cash entries caused cash > snapshot for May 2026.",
  "Villa A-05: ₹1,200 recorded vs ₹1,100 snapshot (+₹100).",
  "Villa A-09: ₹1,300 recorded vs ₹1,100 snapshot (+₹200).",
  "Documented manual-entry variance; grid shows correct PAID amounts for residents.",
].join(" ");

async function main() {
  const admin = await prisma.user.findFirst({
    where: { societyId: SOCIETY_ID, role: "ADMIN", isActive: true },
    select: { id: true, username: true },
  });
  if (!admin) throw new Error("No active admin");

  const aprilCycle = await prisma.maintenanceCollectionCycle.findFirst({
    where: { societyId: SOCIETY_ID, periodMonth: 4, periodYear: 2026 },
    select: { id: true, financialYearId: true, periodKey: true, title: true },
  });
  if (!aprilCycle) throw new Error("April 2026 cycle not found");

  // 1. Reverse mistaken +₹1,100 (if still active)
  const mistaken = await prisma.maintenancePayment.findFirst({
    where: {
      societyId: SOCIETY_ID,
      villaId: VILLA_ID,
      receiptNumber: { startsWith: "RCP202604" },
      amount: 1100,
      reversedAt: null,
      reversalOfPaymentId: null,
      remarks: { contains: "Corrected April" },
    },
    select: { id: true, receiptNumber: true },
  });
  if (mistaken) {
    console.log("1. Reversing mistaken +₹1,100", mistaken.receiptNumber);
    try {
      await prisma.$transaction(
        (tx) =>
          reverseMaintenancePayment(tx, {
            paymentId: mistaken.id,
            societyId: SOCIETY_ID,
            reversedByUserId: admin.id,
            reason: "Rollback live session correction — restore original ₹1,180 bank + ₹80 advance",
          }),
        { timeout: 60_000 },
      );
      console.log("   ✓ Reversed");
    } catch (e) {
      if (e instanceof PaymentReversalError && e.code === "ALREADY_REVERSED") {
        console.log("   (already reversed)");
      } else throw e;
    }
  } else {
    console.log("1. No active mistaken +₹1,100 row (skip)");
  }

  // 2. Restore original ₹1,180 bank (clear reversal + remove offset row)
  const bank1180 = await prisma.maintenancePayment.findUnique({
    where: { id: ORIGINAL_BANK_1180_ID },
    select: { id: true, receiptNumber: true, reversedAt: true },
  });
  const offset1180 = await prisma.maintenancePayment.findFirst({
    where: { reversalOfPaymentId: ORIGINAL_BANK_1180_ID },
    select: { id: true, receiptNumber: true },
  });

  if (bank1180?.reversedAt && offset1180) {
    console.log("2. Restoring original ₹1,180 bank", bank1180.receiptNumber);
    await prisma.$transaction(async (tx) => {
      await tx.maintenancePayment.delete({ where: { id: offset1180.id } });
      await tx.maintenancePayment.update({
        where: { id: bank1180.id },
        data: {
          reversedAt: null,
          reversedByUserId: null,
          reversalReason: null,
        },
      });
    });
    console.log("   ✓ Restored (offset removed, reversal cleared)");
  } else if (bank1180 && !bank1180.reversedAt) {
    console.log("2. ₹1,180 bank already active (skip)");
  } else {
    console.log("2. WARNING: could not find bank1180/offset pair — manual review needed");
  }

  // 3. Remove mistaken unlinked ADJ rows that poison credit pool (not real cash)
  const badAdjs = await prisma.maintenancePayment.findMany({
    where: {
      societyId: SOCIETY_ID,
      villaId: VILLA_ID,
      maintenanceCollectionCycleId: null,
      remarks: { contains: "Manual credit deducted" },
    },
    select: { id: true, receiptNumber: true, amount: true },
  });
  for (const adj of badAdjs) {
    console.log("3. Removing mistaken ADJ", adj.receiptNumber, Number(adj.amount));
    await prisma.maintenancePayment.delete({ where: { id: adj.id } });
  }
  if (badAdjs.length === 0) console.log("3. No mistaken ADJ rows");

  // 4. Re-run credit walker through April
  console.log("4. Credit walker through April…");
  await prisma.$transaction(
    (tx) =>
      applyVillaCreditAcrossSnapshots(tx, {
        societyId: SOCIETY_ID,
        villaId: VILLA_ID,
        financialYearId: aprilCycle.financialYearId,
        throughCycleId: aprilCycle.id,
      }),
    { timeout: 60_000 },
  );

  const snap = await prisma.villaMaintenanceSnapshot.findUnique({
    where: { cycleId_villaId: { cycleId: aprilCycle.id, villaId: VILLA_ID } },
    select: { paidAmount: true, expectedAmount: true, status: true },
  });
  console.log("   Snapshot:", snap);

  const billingCycle = await prisma.billingCycle.findFirst({
    where: {
      societyId: SOCIETY_ID,
      financialYearId: aprilCycle.financialYearId,
      cycleKey: aprilCycle.periodKey,
    },
    select: { id: true },
  });
  if (billingCycle && snap) {
    await prisma.$transaction(
      (tx) =>
        syncBillingUserCyclePaymentsFromSnapshot(tx, {
          societyId: SOCIETY_ID,
          villaId: VILLA_ID,
          billingCycleId: billingCycle.id,
          paidAmount: Number(snap.paidAmount),
          snapStatus: snap.status,
          source: BillingPaymentSource.CASH_MANUAL,
          cashPaidAmount: Number(snap.paidAmount),
        }),
      { timeout: 30_000 },
    );
  }

  // 5. Resolve May alert with notes only
  const mayAlert = await prisma.reconciliationAlert.findFirst({
    where: { societyId: SOCIETY_ID, resolvedAt: null, cycle: { periodMonth: 5, periodYear: 2026 } },
    select: { id: true },
  });
  if (mayAlert) {
    console.log("5. Resolving May alert with notes (no payment changes)");
    await prisma.reconciliationAlert.update({
      where: { id: mayAlert.id },
      data: {
        resolvedAt: new Date(),
        resolvedBy: admin.id,
        notes: MAY_RESOLUTION_NOTES,
      },
    });
  }

  invalidateMoneySnapshotCache(SOCIETY_ID);

  console.log("6. Reconcile…");
  const r = await reconcileSocietyLedger(SOCIETY_ID);
  console.log("   matched:", r.matched, "resolved:", r.alertsResolved);

  const { getVillaCreditBalance } = await import("../src/modules/maintenance-management/credit-walker");
  const credit = await getVillaCreditBalance(prisma, {
    societyId: SOCIETY_ID,
    villaId: VILLA_ID,
    financialYearId: aprilCycle.financialYearId,
  });
  console.log("\n=== Result ===");
  console.log("Credit pool:", credit.creditPool);
  console.log("April snapshot:", snap);
  const open = await prisma.reconciliationAlert.count({
    where: { societyId: SOCIETY_ID, resolvedAt: null },
  });
  console.log("Open alerts:", open);

  const { computeSocietyMoneySnapshot } = await import("../src/lib/societyFinance");
  const money = await computeSocietyMoneySnapshot(prisma, SOCIETY_ID);
  console.log("Society fund:", money.currentFundBalance);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
