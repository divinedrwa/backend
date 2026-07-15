import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { reconcileSocietyLedger } from "../src/lib/reconciliation";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const prisma = new PrismaClient();

async function main() {
  const societyId = "cmp32fto40001qout5koygcqu";
  const r = await reconcileSocietyLedger(societyId);
  console.log("matched:", r.matched);
  for (const c of r.cycleResults.filter((x) => !x.matched)) {
    console.log(`OPEN ${c.cycleTitle}: villa=${c.villaSum} cash=${c.societyCash} diff=${c.difference}`);
  }
  const open = await prisma.reconciliationAlert.findMany({
    where: { societyId, resolvedAt: null },
    include: { cycle: { select: { title: true } } },
  });
  console.log("\nUnresolved:", open.length);
  for (const a of open) {
    console.log(`[${a.severity}] ${a.cycle?.title} diff=${a.difference}`);
  }
}

main().finally(() => prisma.$disconnect());
