import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const societyId = "cmp32fto40001qout5koygcqu";

  const methods = await prisma.paymentMethod.findMany({
    where: { societyId },
    select: { id: true, type: true, isEnabled: true, displayName: true, config: true },
  });
  console.log("PAYMENT METHODS:");
  for (const m of methods) {
    console.log(`  ${m.type} | enabled=${m.isEnabled} | label=${m.label}`);
    console.log(`    config keys:`, m.config ? Object.keys(m.config as object) : "null");
  }

  // Check env vars
  console.log("\nENV VARS:");
  console.log("  RAZORPAY_KEY_ID:", process.env.RAZORPAY_KEY_ID ? "SET" : "MISSING");
  console.log("  RAZORPAY_KEY_SECRET:", process.env.RAZORPAY_KEY_SECRET ? "SET" : "MISSING");
  console.log("  PHONEPE_MERCHANT_ID:", process.env.PHONEPE_MERCHANT_ID ? "SET" : "MISSING");
  console.log("  PHONEPE_SALT_KEY:", process.env.PHONEPE_SALT_KEY ? "SET" : "MISSING");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
