/**
 * Local-only: reverse 3 duplicate December CASH rows for Villa A-03.
 * Keeps: cmpycq8i5024pjl2a0lynatr7 (₹370 on 2026-01-01).
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
const DUPLICATE_IDS = [
  "cmpyc86m5038dk02bjid1vbo6", // ₹370 2026-06-03
  "cmpycx2nv0003ax2979z4i7ti", // ₹360 2026-06-03
  "cmpycmxe3014rjl2a1d8qld5u", // ₹370 2026-06-03 (billing cash sync)
];

async function main() {
  const admin = await prisma.user.findFirst({
    where: { societyId: SOCIETY_ID, role: "ADMIN", isActive: true },
    select: { id: true },
  });
  if (!admin) throw new Error("No admin user");

  for (const paymentId of DUPLICATE_IDS) {
    console.log("Reversing", paymentId, "…");
    await prisma.$transaction(async (tx) => {
      await reverseMaintenancePayment(tx, {
        paymentId,
        societyId: SOCIETY_ID,
        reversedByUserId: admin.id,
        reason: "Duplicate manual CASH entry — December 2025 cycle; keep single ₹370 payment on 2026-01-01",
      });
    }, { timeout: 60_000 });
  }

  // Ensure snapshot matches the one valid ₹370 payment
  await prisma.$executeRaw`
    UPDATE "VillaMaintenanceSnapshot" vs
    SET "paidAmount" = 370.00, status = 'PAID', "updatedAt" = NOW()
    FROM "Villa" v, "MaintenanceCollectionCycle" mc
    WHERE vs."villaId" = v.id AND vs."cycleId" = mc.id
      AND v."villaNumber" = '03' AND v.block = 'A'
      AND mc.title = 'December Month Maintenance Payment'
  `;

  const result = await reconcileSocietyLedger(SOCIETY_ID);
  console.log("\nReconcile matched:", result.matched);
  for (const c of result.cycleResults.filter((r) => !r.matched)) {
    console.log("  OPEN:", c.cycleTitle, "diff", c.difference);
  }

  const open = await prisma.reconciliationAlert.count({
    where: { societyId: SOCIETY_ID, resolvedAt: null },
  });
  console.log("Unresolved alerts:", open);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
