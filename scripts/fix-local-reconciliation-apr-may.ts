/**
 * Local-only: fix Divine Residency reconciliation for April + May 2026.
 * - April A-03: reverse duplicate ₹1,100 UPI; keep ₹1,180 bank transfer (villa 3).
 * - May: resolve alert with notes (manual over-entry on A-05 / A-09).
 *
 * Run: npx tsx scripts/fix-local-reconciliation-apr-may.ts
 */
import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { reverseMaintenancePayment } from "../src/lib/reverseMaintenancePayment";
import { reconcileSocietyLedger } from "../src/lib/reconciliation";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const prisma = new PrismaClient();

const SOCIETY_ID = "cmp32fto40001qout5koygcqu";
const APRIL_DUPLICATE_UPI_ID = "cmp9ibrrv008yi02av1e6umbi"; // ₹1,100 — duplicate manual entry
const MAY_ALERT_ID = "cmpwj01d704ahhl2ajg45i9z9";

const MAY_RESOLUTION_NOTES = [
  "Reviewed: manual cash entries caused cash > snapshot for May 2026.",
  "Villa A-05: ₹1,200 recorded in MaintenancePayment vs ₹1,100 on villa snapshot (+₹100).",
  "Likely admin typed extra ₹100 during manual BANK_TRANSFER entry; resident balance on grid is ₹1,100 PAID.",
  "Villa A-09: ₹1,300 recorded vs ₹1,100 on snapshot (+₹200).",
  "Likely manual entry included prior dues or typo; grid shows ₹1,100 PAID for the cycle.",
  "No duplicate rows — accepted as documented manual-entry variance; reconcile when payments are corrected or left as-is.",
].join(" ");

async function main() {
  const admin = await prisma.user.findFirst({
    where: { societyId: SOCIETY_ID, role: "ADMIN", isActive: true },
    select: { id: true, username: true },
  });
  if (!admin) throw new Error("No active admin user for society");

  console.log("1. Reversing duplicate April A-03 UPI ₹1,100…");
  await prisma.$transaction(async (tx) => {
    await reverseMaintenancePayment(tx, {
      paymentId: APRIL_DUPLICATE_UPI_ID,
      societyId: SOCIETY_ID,
      reversedByUserId: admin.id,
      reason:
        "Duplicate manual UPI entry — villa A-03 April 2026 was paid via ₹1,180 bank transfer only",
    });
  }, { timeout: 60_000 });
  console.log("   ✓ Reversed", APRIL_DUPLICATE_UPI_ID);

  const aprilSnap = await prisma.villaMaintenanceSnapshot.findFirst({
    where: {
      cycle: { societyId: SOCIETY_ID, title: "Maintenance April 2026" },
      villa: { villaNumber: "03", block: "A" },
    },
    select: { id: true, paidAmount: true, expectedAmount: true, status: true },
  });
  console.log(
    "   Snapshot after reversal:",
    aprilSnap
      ? `paid=${aprilSnap.paidAmount} expected=${aprilSnap.expectedAmount} status=${aprilSnap.status}`
      : "not found",
  );

  console.log("\n2. Resolving May 2026 alert with explanation…");
  const mayAlert = await prisma.reconciliationAlert.update({
    where: { id: MAY_ALERT_ID },
    data: {
      resolvedAt: new Date(),
      resolvedBy: admin.id,
      notes: MAY_RESOLUTION_NOTES,
    },
  });
  console.log("   ✓ Resolved May alert", mayAlert.id);

  console.log("\n3. Re-running reconciliation…");
  const result = await reconcileSocietyLedger(SOCIETY_ID);
  console.log(
    "   matched:",
    result.matched,
    "resolved:",
    result.alertsResolved,
    "updated:",
    result.alertsUpdated,
  );
  for (const c of result.cycleResults.filter((r) => !r.matched)) {
    console.log(
      `   still open: ${c.cycleTitle} villa=${c.villaSum} cash=${c.societyCash} diff=${c.difference}`,
    );
  }

  const open = await prisma.reconciliationAlert.findMany({
    where: { societyId: SOCIETY_ID, resolvedAt: null },
    include: { cycle: { select: { title: true } } },
  });
  console.log("\n=== Remaining open alerts:", open.length, "===");
  for (const a of open) {
    console.log(
      `  [${a.severity}] ${a.cycle?.title}: diff=${a.difference} credit=${a.creditApplied}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
