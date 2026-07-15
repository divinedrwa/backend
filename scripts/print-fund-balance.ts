import path from "path";
import dotenv from "dotenv";
import { prisma } from "../src/lib/prisma";
import { computeSocietyMoneySnapshot } from "../src/lib/societyFinance";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

async function main() {
  const societyId = "cmp32fto40001qout5koygcqu";
  const m = await computeSocietyMoneySnapshot(prisma, societyId);
  const spendable = m.currentFundBalance - m.totalAdvanceCredit;
  console.log({
    maintenanceCashAllTime: m.maintenanceCashAllTime,
    additionalFundsAllTime: m.additionalFundsAllTime,
    expensesAllTime: m.expensesAllTime,
    currentFundBalance: m.currentFundBalance,
    totalAdvanceCredit: m.totalAdvanceCredit,
    spendableFund: spendable,
    formula: `(maintenance ${m.maintenanceCashAllTime} + additional ${m.additionalFundsAllTime}) - expenses ${m.expensesAllTime}`,
  });
}

main().finally(() => prisma.$disconnect());
