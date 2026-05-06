import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const defaultCategories = [
  {
    name: "Electricity Recharge",
    description: "Electricity bill payments and recharges",
    icon: "⚡",
    color: "#F59E0B",
    type: "ELECTRICITY" as const,
    isRecurring: true,
  },
  {
    name: "Water Bills",
    description: "Municipal water supply bills",
    icon: "💧",
    color: "#3B82F6",
    type: "WATER" as const,
    isRecurring: true,
  },
  {
    name: "Garbage Collection",
    description: "Garbage collector payment",
    icon: "🗑️",
    color: "#10B981",
    type: "GARBAGE_COLLECTION" as const,
    isRecurring: true,
  },
  {
    name: "Security Guard Salary",
    description: "Monthly salary for security guards",
    icon: "👮",
    color: "#6366F1",
    type: "SECURITY_SALARY" as const,
    isRecurring: true,
  },
  {
    name: "Housekeeping Salary",
    description: "Monthly salary for housekeeping staff",
    icon: "🧹",
    color: "#EC4899",
    type: "HOUSEKEEPING_SALARY" as const,
    isRecurring: true,
  },
  {
    name: "Lift Maintenance",
    description: "Elevator maintenance and AMC",
    icon: "🏢",
    color: "#8B5CF6",
    type: "LIFT_MAINTENANCE" as const,
    isRecurring: false,
  },
  {
    name: "Generator Maintenance",
    description: "Generator servicing and fuel",
    icon: "⚙️",
    color: "#F97316",
    type: "GENERATOR_MAINTENANCE" as const,
    isRecurring: false,
  },
  {
    name: "Pest Control",
    description: "Pest control services",
    icon: "🐜",
    color: "#EF4444",
    type: "PEST_CONTROL" as const,
    isRecurring: false,
  },
  {
    name: "Gardening Services",
    description: "Lawn maintenance and gardening",
    icon: "🌿",
    color: "#22C55E",
    type: "GARDENING" as const,
    isRecurring: true,
  },
  {
    name: "Insurance",
    description: "Society insurance premiums",
    icon: "🛡️",
    color: "#06B6D4",
    type: "INSURANCE" as const,
    isRecurring: false,
  },
  {
    name: "Legal Fees",
    description: "Legal and professional fees",
    icon: "⚖️",
    color: "#64748B",
    type: "LEGAL_FEES" as const,
    isRecurring: false,
  },
  {
    name: "Software Subscription",
    description: "Management software subscriptions",
    icon: "💻",
    color: "#3B82F6",
    type: "SOFTWARE_SUBSCRIPTION" as const,
    isRecurring: true,
  },
  {
    name: "Common Area Repairs",
    description: "Repairs and maintenance of common areas",
    icon: "🔨",
    color: "#F97316",
    type: "COMMON_AREA_REPAIR" as const,
    isRecurring: false,
  },
  {
    name: "Miscellaneous",
    description: "Other miscellaneous expenses",
    icon: "📋",
    color: "#6B7280",
    type: "MISCELLANEOUS" as const,
    isRecurring: false,
  },
];

async function seedAll() {
  console.log("🌱 Starting auto-seed for all societies...\n");

  // Get all societies
  const societies = await prisma.society.findMany({
    select: { id: true, name: true },
  });

  if (societies.length === 0) {
    console.log("❌ No societies found in the database!");
    return;
  }

  console.log(`📍 Found ${societies.length} society/societies:\n`);

  for (const society of societies) {
    console.log(`\n🏘️  Processing: ${society.name} (${society.id})`);
    console.log("─".repeat(60));

    let created = 0;
    let skipped = 0;

    for (const category of defaultCategories) {
      try {
        const existing = await prisma.expenseCategory.findUnique({
          where: {
            societyId_name: {
              societyId: society.id,
              name: category.name,
            },
          },
        });

        if (existing) {
          skipped++;
          continue;
        }

        await prisma.expenseCategory.create({
          data: {
            ...category,
            societyId: society.id,
          },
        });
        created++;
      } catch (error) {
        console.error(`  ❌ Error creating "${category.name}":`, error);
      }
    }

    console.log(`\n  ✅ Created: ${created} categories`);
    console.log(`  ⏭️  Skipped: ${skipped} (already exist)`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("✨ Auto-seed complete!\n");
}

seedAll()
  .catch((error) => {
    console.error("\n❌ Seeding failed:", error);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
