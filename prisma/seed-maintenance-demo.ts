/**
 * Idempotent demo data for Maintenance / Payments / Expenses (mobile + admin).
 * Safe to re-run: upserts maintenance, syncs payments, refreshes demo expenses & summaries.
 *
 * Usage: npm run prisma:seed-maintenance-demo
 */
import { PrismaClient, MaintenanceStatus, PaymentMode } from "@prisma/client";

const prisma = new PrismaClient();

const DEMO_EXPENSE_TITLE_PREFIX = "[Demo]";

function prevPeriod(month: number, year: number): { month: number; year: number } {
  if (month <= 1) return { month: 12, year: year - 1 };
  return { month: month - 1, year };
}

async function calculateAndSaveMonthlySummary(societyId: string, month: number, year: number) {
  const expenses = await prisma.expense.findMany({
    where: {
      societyId,
      month,
      year,
      status: "APPROVED",
    },
    include: { category: true },
  });

  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const totalGST = expenses.reduce((sum, e) => sum + (e.gstAmount || 0), 0);
  const totalTDS = expenses.reduce((sum, e) => sum + (e.tdsAmount || 0), 0);
  const netAmount = expenses.reduce((sum, e) => sum + e.netAmount, 0);
  const categoryBreakdown: Record<string, number> = {};
  for (const expense of expenses) {
    const catName = expense.category.name;
    categoryBreakdown[catName] = (categoryBreakdown[catName] || 0) + expense.amount;
  }

  await prisma.monthlyExpenseSummary.upsert({
    where: { societyId_month_year: { societyId, month, year } },
    update: {
      totalExpenses,
      totalGST,
      totalTDS,
      netAmount,
      expenseCount: expenses.length,
      categoryBreakdown,
      lastCalculated: new Date(),
    },
    create: {
      societyId,
      month,
      year,
      totalExpenses,
      totalGST,
      totalTDS,
      netAmount,
      expenseCount: expenses.length,
      categoryBreakdown,
      lastCalculated: new Date(),
    },
  });
}

async function ensureCategories(societyId: string) {
  const defs: { name: string; type: "SECURITY_SALARY" | "GARDENING" | "ELECTRICITY" | "COMMON_AREA_REPAIR" | "MISCELLANEOUS" }[] = [
    { name: "Security & guarding", type: "SECURITY_SALARY" },
    { name: "Landscaping", type: "GARDENING" },
    { name: "Common electricity", type: "ELECTRICITY" },
    { name: "Repairs & upkeep", type: "COMMON_AREA_REPAIR" },
    { name: "Misc society", type: "MISCELLANEOUS" },
  ];
  const out: { id: string; name: string }[] = [];
  for (const d of defs) {
    const row = await prisma.expenseCategory.upsert({
      where: { societyId_name: { societyId, name: d.name } },
      update: { isActive: true, type: d.type },
      create: {
        societyId,
        name: d.name,
        type: d.type,
        isActive: true,
        description: "Seeded for maintenance demo",
      },
    });
    out.push({ id: row.id, name: row.name });
  }
  return out;
}

async function refreshDemoExpenses(
  societyId: string,
  month: number,
  year: number,
  categories: { id: string; name: string }[],
) {
  await prisma.expense.deleteMany({
    where: {
      societyId,
      month,
      year,
      title: { startsWith: DEMO_EXPENSE_TITLE_PREFIX },
    },
  });

  const pick = (i: number) => categories[i % categories.length];
  const payDate = new Date(year, month - 1, 12);

  const rows: { title: string; amount: number; catIdx: number; paidTo: string }[] = [
    { title: `${DEMO_EXPENSE_TITLE_PREFIX} Security agency — Period`, amount: 28500, catIdx: 0, paidTo: "SecureWatch Services" },
    { title: `${DEMO_EXPENSE_TITLE_PREFIX} Garden & lawn`, amount: 8200, catIdx: 1, paidTo: "GreenCare LLP" },
    { title: `${DEMO_EXPENSE_TITLE_PREFIX} Clubhouse electricity`, amount: 12400, catIdx: 2, paidTo: "State Discom" },
    { title: `${DEMO_EXPENSE_TITLE_PREFIX} Driveway patch work`, amount: 15600, catIdx: 3, paidTo: "BuildRight Contractors" },
    { title: `${DEMO_EXPENSE_TITLE_PREFIX} Stationery & admin`, amount: 2100, catIdx: 4, paidTo: "OfficeMart" },
  ];

  for (const r of rows) {
    const c = pick(r.catIdx);
    await prisma.expense.create({
      data: {
        societyId,
        categoryId: c.id,
        title: r.title,
        description: "Auto-generated demo expense for dashboard",
        amount: r.amount,
        paymentDate: payDate,
        paymentMode: PaymentMode.BANK_TRANSFER,
        paidTo: r.paidTo,
        paidToContact: "+91 9800000000",
        month,
        year,
        netAmount: r.amount,
        status: "APPROVED",
        approvedAt: payDate,
        tags: ["demo", "maintenance-module"],
      },
    });
  }

  await calculateAndSaveMonthlySummary(societyId, month, year);
}

async function syncMaintenanceAndPayments(societyId: string, month: number, year: number) {
  const villas = await prisma.villa.findMany({
    where: { societyId },
    orderBy: { villaNumber: "asc" },
  });

  if (villas.length === 0) {
    console.log(`  ⏭ No villas for society ${societyId}, skip maintenance`);
    return;
  }

  const bank = await prisma.bankAccount.findFirst({ where: { societyId, isActive: true } });

  let idx = 0;
  for (const villa of villas) {
    const amount = villa.monthlyMaintenance;
    const dueDate = new Date(year, month - 1, 7);
    // ~55% paid: pattern varies by index and month so both months look realistic
    const paid = (idx + month) % 3 !== 0;

    const maintenance = await prisma.maintenance.upsert({
      where: { villaId_month_year: { villaId: villa.id, month, year } },
      create: {
        societyId,
        villaId: villa.id,
        month,
        year,
        amount,
        dueDate,
        status: paid ? MaintenanceStatus.PAID : MaintenanceStatus.PENDING,
      },
      update: {
        amount,
        dueDate,
        status: paid ? MaintenanceStatus.PAID : MaintenanceStatus.PENDING,
      },
    });

    if (paid) {
      const receiptNumber = `RCP-${year}-${String(month).padStart(2, "0")}-${villa.id.slice(-8)}`;
      const existing = await prisma.maintenancePayment.findFirst({
        where: { societyId, villaId: villa.id, month, year },
      });
      const paymentDate = new Date(year, month - 1, 10 + (idx % 5));

      if (existing) {
        await prisma.maintenancePayment.update({
          where: { id: existing.id },
          data: {
            amount,
            paymentDate,
            paymentMode: idx % 2 === 0 ? PaymentMode.UPI : PaymentMode.ONLINE,
            maintenanceId: maintenance.id,
            remarks: "Demo payment (re-seeded)",
          },
        });
      } else {
        await prisma.maintenancePayment.create({
          data: {
            societyId,
            villaId: villa.id,
            maintenanceId: maintenance.id,
            month,
            year,
            amount,
            paymentDate,
            paymentMode: idx % 2 === 0 ? PaymentMode.UPI : PaymentMode.ONLINE,
            receiptNumber,
            transactionId: `DEMO-${receiptNumber}`,
            bankAccountId: bank?.id ?? undefined,
            remarks: "Demo payment",
          },
        });
      }
    } else {
      await prisma.maintenancePayment.deleteMany({
        where: { societyId, villaId: villa.id, month, year },
      });
    }

    idx += 1;
  }

  console.log(`  ✓ Maintenance + payments for ${year}-${String(month).padStart(2, "0")} (${villas.length} villas)`);
}

async function main() {
  console.log("🌱 Seeding maintenance / payment / expense demo data…\n");

  const societies = await prisma.society.findMany({ select: { id: true, name: true } });
  if (societies.length === 0) {
    console.log("No societies found. Run `npm run prisma:seed` first.");
    process.exit(1);
  }

  const now = new Date();
  const m0 = now.getMonth() + 1;
  const y0 = now.getFullYear();
  const p = prevPeriod(m0, y0);
  const months = [
    { month: m0, year: y0 },
    { month: p.month, year: p.year },
  ];

  for (const soc of societies) {
    console.log(`Society: ${soc.name} (${soc.id})`);
    for (const { month, year } of months) {
      await syncMaintenanceAndPayments(soc.id, month, year);
    }
    const categories = await ensureCategories(soc.id);
    for (const { month, year } of months) {
      await refreshDemoExpenses(soc.id, month, year, categories);
    }
    console.log(`  ✓ Demo expenses + monthly summaries (2 months)\n`);
  }

  const sampleUser = await prisma.user.findFirst({
    where: { username: "resident1" },
    select: { email: true, username: true, villa: { select: { villaNumber: true } } },
  });
  if (sampleUser) {
    console.log("📱 Log in on mobile as:", sampleUser.email, "(resident123)");
    console.log("   Villa:", sampleUser.villa?.villaNumber ?? "(assign villa if null)");
  }
  console.log("\n✅ Done. Open Maintenance & payments in the app for the current month.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
