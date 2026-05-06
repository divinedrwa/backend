/**
 * Sample maintenance billing cycle seed.
 * Run: `npx tsx prisma/seed-maintenance-billing.ts`
 */
import { PrismaClient, BillingCycleStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const society = await prisma.society.findFirst({ orderBy: { createdAt: "asc" } });
  if (!society) {
    console.error("No society found — run main seed first.");
    process.exit(1);
  }

  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const cycleKey = `${y}-${String(m).padStart(2, "0")}`;

  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59));
  const payStart = new Date(Date.UTC(y, m - 1, 5, 0, 0, 0));
  const payEnd = new Date(Date.UTC(y, m, 10, 23, 59, 59));

  const status = now <= payStart ? BillingCycleStatus.UPCOMING : now <= payEnd ? BillingCycleStatus.OPEN : BillingCycleStatus.CLOSED;

  const existing = await prisma.billingCycle.findUnique({
    where: { societyId_cycleKey: { societyId: society.id, cycleKey } },
  });
  if (existing) {
    console.log("Sample cycle already exists:", existing.id);
    return;
  }

  const cycle = await prisma.billingCycle.create({
    data: {
      societyId: society.id,
      cycleKey,
      title: `Maintenance ${cycleKey}`,
      amount: 2500,
      startDate: start,
      endDate: end,
      paymentStartDate: payStart,
      paymentEndDate: payEnd,
      lateFee: 250,
      gracePeriodDays: 3,
      status,
    },
  });

  console.log("Created billing cycle:", cycle.id, cycle.cycleKey, cycle.status);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
