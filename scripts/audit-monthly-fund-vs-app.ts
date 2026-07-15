/**
 * Month-by-month audit: snapshot "collected" (app grid) vs cash ledger (fund balance).
 * Run: npx tsx scripts/audit-monthly-fund-vs-app.ts
 */
import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { computeSocietyMoneySnapshot } from "../src/lib/societyFinance";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const prisma = new PrismaClient();
const SOCIETY_ID = "cmp32fto40001qout5koygcqu";

function fmt(n: number) {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

async function main() {
  const society = await prisma.society.findUnique({
    where: { id: SOCIETY_ID },
    select: { name: true },
  });
  if (!society) throw new Error("Society not found");

  const money = await computeSocietyMoneySnapshot(prisma, SOCIETY_ID);

  const cycles = await prisma.maintenanceCollectionCycle.findMany({
    where: { societyId: SOCIETY_ID },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: { id: true, title: true, periodMonth: true, periodYear: true },
  });

  const mcByFyKey = new Map<string, string>();
  const maintenanceCycles = await prisma.maintenanceCollectionCycle.findMany({
    where: { societyId: SOCIETY_ID },
    select: { id: true, financialYearId: true, periodKey: true },
  });
  for (const mc of maintenanceCycles) {
    mcByFyKey.set(`${mc.financialYearId}:${mc.periodKey}`, mc.id);
  }

  const [snapshots, maintenancePayments, userCyclePayments, expenses] = await Promise.all([
    prisma.villaMaintenanceSnapshot.findMany({
      where: { cycle: { societyId: SOCIETY_ID } },
      select: { villaId: true, cycleId: true, paidAmount: true, expectedAmount: true },
    }),
    prisma.maintenancePayment.findMany({
      where: { societyId: SOCIETY_ID, maintenanceCollectionCycleId: { not: null } },
      select: {
        id: true,
        villaId: true,
        maintenanceCollectionCycleId: true,
        amount: true,
        paymentDate: true,
        paymentMode: true,
        receiptNumber: true,
        reversalOfPaymentId: true,
        villa: { select: { block: true, villaNumber: true } },
      },
    }),
    prisma.userCyclePayment.findMany({
      where: { paymentStatus: "SUCCESS", cycle: { societyId: SOCIETY_ID } },
      select: {
        amountPaid: true,
        cycle: { select: { financialYearId: true, cycleKey: true } },
        user: { select: { villaId: true } },
      },
    }),
    prisma.expense.findMany({
      where: { societyId: SOCIETY_ID, status: "APPROVED", deletedAt: null },
      select: { amount: true, month: true, year: true },
    }),
  ]);

  const snapByCycle = new Map<string, number>();
  for (const s of snapshots) {
    snapByCycle.set(s.cycleId, (snapByCycle.get(s.cycleId) ?? 0) + Number(s.paidAmount));
  }

  const mpByKey = new Map<string, number>();
  const mpRowsByCycle = new Map<string, typeof maintenancePayments>();
  for (const mp of maintenancePayments) {
    const cycleId = mp.maintenanceCollectionCycleId!;
    const key = `${mp.villaId}:${cycleId}`;
    mpByKey.set(key, (mpByKey.get(key) ?? 0) + Number(mp.amount));
    const list = mpRowsByCycle.get(cycleId) ?? [];
    list.push(mp);
    mpRowsByCycle.set(cycleId, list);
  }

  const ucpByKey = new Map<string, number>();
  for (const ucp of userCyclePayments) {
    const villaId = ucp.user?.villaId;
    if (!villaId) continue;
    const mcId = mcByFyKey.get(`${ucp.cycle.financialYearId}:${ucp.cycle.cycleKey}`);
    if (!mcId) continue;
    const key = `${villaId}:${mcId}`;
    ucpByKey.set(key, Math.max(ucpByKey.get(key) ?? 0, Number(ucp.amountPaid)));
  }

  const cashByCycle = new Map<string, number>();
  const allKeys = new Set<string>([...mpByKey.keys(), ...ucpByKey.keys()]);
  for (const key of allKeys) {
    const [, cycleId] = key.split(":") as [string, string];
    const mpSum = mpByKey.get(key) ?? 0;
    const ucpMax = ucpByKey.get(key) ?? 0;
    const cashReceived = mpSum > 0.005 ? Math.max(mpSum, ucpMax) : 0;
    if (cashReceived <= 0.005) continue;
    cashByCycle.set(cycleId, (cashByCycle.get(cycleId) ?? 0) + cashReceived);
  }

  const expenseByMonth = new Map<string, number>();
  for (const e of expenses) {
    const k = `${e.year}-${String(e.month).padStart(2, "0")}`;
    expenseByMonth.set(k, (expenseByMonth.get(k) ?? 0) + Number(e.amount));
  }

  console.log(`\n=== ${society.name} — Monthly audit (local DB) ===\n`);
  console.log(
    "Columns: App collected = sum(snapshot.paidAmount) | Fund cash = MP+gateway ledger | Hidden excess = fund cash − app collected",
  );
  console.log("-".repeat(110));

  let cumSnap = 0;
  let cumCash = 0;
  let cumExpense = 0;
  const problemCycles: Array<{
    title: string;
    excess: number;
    villas: string[];
  }> = [];

  for (const c of cycles) {
    const snap = snapByCycle.get(c.id) ?? 0;
    const cash = cashByCycle.get(c.id) ?? 0;
    const excess = cash - snap;
    const ym = `${c.periodYear}-${String(c.periodMonth).padStart(2, "0")}`;
    const exp = expenseByMonth.get(ym) ?? 0;

    cumSnap += snap;
    cumCash += cash;
    cumExpense += exp;

    const flag = Math.abs(excess) > 0.5 ? " ⚠" : "";
    console.log(
      `${ym}  ${c.title.padEnd(28)}  app:${fmt(snap).padStart(10)}  fund:${fmt(cash).padStart(10)}  excess:${fmt(excess).padStart(8)}  exp:${fmt(exp).padStart(8)}${flag}`,
    );

    if (excess > 0.5) {
      const villas: string[] = [];
      const rows = mpRowsByCycle.get(c.id) ?? [];
      const byVilla = new Map<string, { snap: number; cash: number; rows: number }>();
      for (const s of snapshots.filter((x) => x.cycleId === c.id)) {
        const key = `${s.villaId}:${c.id}`;
        const mpSum = mpByKey.get(key) ?? 0;
        const ucpMax = ucpByKey.get(key) ?? 0;
        const villaCash = mpSum > 0.005 ? Math.max(mpSum, ucpMax) : 0;
        if (villaCash - Number(s.paidAmount) > 0.5) {
          byVilla.set(s.villaId, {
            snap: Number(s.paidAmount),
            cash: villaCash,
            rows: rows.filter((r) => r.villaId === s.villaId).length,
          });
        }
      }
      for (const [villaId, v] of byVilla) {
        const villa = await prisma.villa.findUnique({
          where: { id: villaId },
          select: { block: true, villaNumber: true },
        });
        villas.push(
          `${villa?.block ?? ""}-${villa?.villaNumber ?? "?"} snap ${v.snap} cash ${v.cash} (${v.rows} MP rows)`,
        );
      }
      if (villas.length) problemCycles.push({ title: c.title, excess, villas });
    }
  }

  console.log("-".repeat(110));
  console.log(
    `TOTALS (all cycles)     app collected: ${fmt(cumSnap)}  fund cash: ${fmt(cumCash)}  hidden excess: ${fmt(cumCash - cumSnap)}  expenses: ${fmt(cumExpense)}`,
  );
  console.log(`\nFUND BALANCE ENGINE (all-time):`);
  console.log(`  maintenanceCashAllTime: ${fmt(money.maintenanceCashAllTime)}`);
  console.log(`  expensesAllTime:        ${fmt(money.expensesAllTime)}`);
  console.log(`  currentFundBalance:     ${fmt(money.currentFundBalance)}`);
  console.log(`  check: cash − expenses = ${fmt(money.maintenanceCashAllTime - money.expensesAllTime)}`);

  if (problemCycles.length) {
    console.log(`\n=== Cycles where fund cash > app collected (duplicates hidden from grid) ===`);
    for (const p of problemCycles) {
      console.log(`\n${p.title} — excess ${fmt(p.excess)}`);
      for (const v of p.villas) console.log(`  • ${v}`);
    }
  } else {
    console.log(`\n✓ No per-cycle hidden excess — app collected matches fund cash for every month.`);
  }

  // Payment history rows that are offsets (negative) — app may or may not show
  const offsets = maintenancePayments.filter((p) => p.reversalOfPaymentId);
  if (offsets.length) {
    console.log(`\n=== Reversal offset rows (${offsets.length}) — reduce fund, rarely shown on grid ===`);
    for (const o of offsets) {
      const v = o.villa;
      console.log(
        `  ${o.paymentDate.toISOString().slice(0, 10)} ${v?.block}-${v?.villaNumber} ${fmt(Number(o.amount))} ${o.receiptNumber}`,
      );
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
