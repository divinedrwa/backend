import { PrismaClient, PaymentMode } from "@prisma/client";

const prisma = new PrismaClient();

async function seedSampleExpenses() {
  console.log("🌱 Creating sample expense entries...\n");

  // Get the society
  const society = await prisma.society.findFirst();
  if (!society) {
    console.log("❌ No society found!");
    return;
  }

  // Get all categories
  const categories = await prisma.expenseCategory.findMany({
    where: { societyId: society.id },
  });

  if (categories.length === 0) {
    console.log("❌ No categories found! Run seed-expense-categories first.");
    return;
  }

  console.log(`📍 Society: ${society.name}`);
  console.log(`📂 Found ${categories.length} categories\n`);

  const currentDate = new Date();
  const currentMonth = currentDate.getMonth() + 1;
  const currentYear = currentDate.getFullYear();

  const sampleExpenses = [
    // This month
    {
      categoryName: "Electricity Recharge",
      title: `Electricity Bill - ${currentDate.toLocaleString('default', { month: 'long' })} ${currentYear}`,
      amount: 45000,
      paymentDate: new Date(currentYear, currentMonth - 1, 5),
      paymentMode: "UPI" as PaymentMode,
      paidTo: "State Electricity Board",
      gstPercentage: 18,
    },
    {
      categoryName: "Security Guard Salary",
      title: `Security Guard Salary - ${currentDate.toLocaleString('default', { month: 'long' })}`,
      amount: 85000,
      paymentDate: new Date(currentYear, currentMonth - 1, 1),
      paymentMode: "BANK_TRANSFER" as PaymentMode,
      paidTo: "Various Guards",
      tdsPercentage: 10,
    },
    {
      categoryName: "Garbage Collection",
      title: `Garbage Collector Payment - ${currentDate.toLocaleString('default', { month: 'long' })}`,
      amount: 12000,
      paymentDate: new Date(currentYear, currentMonth - 1, 1),
      paymentMode: "CASH" as PaymentMode,
      paidTo: "Municipal Corporation",
    },
    {
      categoryName: "Housekeeping Salary",
      title: "Housekeeping Staff Salary",
      amount: 48000,
      paymentDate: new Date(currentYear, currentMonth - 1, 1),
      paymentMode: "BANK_TRANSFER" as PaymentMode,
      paidTo: "Housekeeping Team",
      tdsPercentage: 10,
    },
    {
      categoryName: "Water Bills",
      title: `Water Supply Bill - ${currentDate.toLocaleString('default', { month: 'long' })}`,
      amount: 18000,
      paymentDate: new Date(currentYear, currentMonth - 1, 10),
      paymentMode: "ONLINE" as PaymentMode,
      paidTo: "City Water Department",
    },
    // Last month
    {
      categoryName: "Electricity Recharge",
      title: `Electricity Bill - ${new Date(currentYear, currentMonth - 2, 1).toLocaleString('default', { month: 'long' })}`,
      amount: 42000,
      paymentDate: new Date(currentYear, currentMonth - 2, 5),
      paymentMode: "UPI" as PaymentMode,
      paidTo: "State Electricity Board",
      gstPercentage: 18,
    },
    {
      categoryName: "Security Guard Salary",
      title: `Security Guard Salary - ${new Date(currentYear, currentMonth - 2, 1).toLocaleString('default', { month: 'long' })}`,
      amount: 85000,
      paymentDate: new Date(currentYear, currentMonth - 2, 1),
      paymentMode: "BANK_TRANSFER" as PaymentMode,
      paidTo: "Various Guards",
      tdsPercentage: 10,
    },
    {
      categoryName: "Lift Maintenance",
      title: "Annual Lift Maintenance Contract",
      amount: 125000,
      paymentDate: new Date(currentYear, currentMonth - 2, 15),
      paymentMode: "CHEQUE" as PaymentMode,
      paidTo: "Otis Elevator Company",
      gstPercentage: 18,
      receiptNumber: "INV-2024-1234",
    },
    {
      categoryName: "Pest Control",
      title: "Quarterly Pest Control Service",
      amount: 8500,
      paymentDate: new Date(currentYear, currentMonth - 2, 20),
      paymentMode: "BANK_TRANSFER" as PaymentMode,
      paidTo: "Pest Away Services",
      gstPercentage: 18,
    },
    {
      categoryName: "Gardening Services",
      title: `Gardening Maintenance - ${new Date(currentYear, currentMonth - 2, 1).toLocaleString('default', { month: 'long' })}`,
      amount: 15000,
      paymentDate: new Date(currentYear, currentMonth - 2, 1),
      paymentMode: "CASH" as PaymentMode,
      paidTo: "Green Thumb Landscaping",
    },
    // Two months ago
    {
      categoryName: "Software Subscription",
      title: "Society Management Software - Annual Subscription",
      amount: 95000,
      paymentDate: new Date(currentYear, currentMonth - 3, 1),
      paymentMode: "ONLINE" as PaymentMode,
      paidTo: "Divine Society Solutions",
      gstPercentage: 18,
      receiptNumber: "SUB-2024-5678",
    },
    {
      categoryName: "Insurance",
      title: "Society Property Insurance Premium",
      amount: 250000,
      paymentDate: new Date(currentYear, currentMonth - 3, 5),
      paymentMode: "BANK_TRANSFER" as PaymentMode,
      paidTo: "HDFC ERGO General Insurance",
      gstPercentage: 18,
    },
  ];

  let created = 0;

  for (const expense of sampleExpenses) {
    try {
      const category = categories.find((c) => c.name === expense.categoryName);
      if (!category) {
        console.log(`  ⏭️  Category "${expense.categoryName}" not found, skipping...`);
        continue;
      }

      const gstAmount = expense.gstPercentage
        ? (expense.amount * expense.gstPercentage) / 100
        : 0;
      const tdsAmount = expense.tdsPercentage
        ? (expense.amount * expense.tdsPercentage) / 100
        : 0;
      const netAmount = expense.amount + gstAmount - tdsAmount;

      await prisma.expense.create({
        data: {
          societyId: society.id,
          categoryId: category.id,
          title: expense.title,
          amount: expense.amount,
          paymentDate: expense.paymentDate,
          paymentMode: expense.paymentMode,
          paidTo: expense.paidTo,
          month: expense.paymentDate.getMonth() + 1,
          year: expense.paymentDate.getFullYear(),
          gstAmount,
          gstPercentage: expense.gstPercentage || 0,
          tdsAmount,
          tdsPercentage: expense.tdsPercentage || 0,
          netAmount,
          receiptNumber: expense.receiptNumber,
          status: "APPROVED",
        },
      });

      console.log(`  ✅ Created: ${expense.title}`);
      created++;
    } catch (error) {
      console.error(`  ❌ Error creating "${expense.title}":`, error);
    }
  }

  console.log(`\n✨ Created ${created} sample expenses!\n`);
}

seedSampleExpenses()
  .catch((error) => {
    console.error("\n❌ Seeding failed:", error);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
