import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting seed...");
  const adminEmail = (process.env.DEMO_ADMIN_EMAIL ?? "admin@society.local").trim();
  const adminUsername = (process.env.DEMO_ADMIN_USERNAME ?? "admin").trim();
  const adminPassword = (process.env.DEMO_ADMIN_PASSWORD ?? "ChangeMe123!").trim();
  const guardPassword = (process.env.DEMO_GUARD_PASSWORD ?? "ChangeMe123!").trim();
  const residentPassword = (process.env.DEMO_RESIDENT_PASSWORD ?? "ChangeMe123!").trim();

  // Create default society
  const society = await prisma.society.upsert({
    where: { id: "default-society" },
    update: {},
    create: {
      id: "default-society",
      name: "Green Valley Villa Society",
      address: "Sector 15, Green Valley, Mumbai - 400001",
    },
  });

  console.log("✅ Society created:", society.name);

  // Create admin user
  const adminPasswordHash = await bcrypt.hash(adminPassword, 10);
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      societyId: society.id,
      username: adminUsername,
      name: "Admin User",
      email: adminEmail,
      passwordHash: adminPasswordHash,
      role: "ADMIN",
      phone: "+91 9876543210",
      isActive: true,
    },
  });

  console.log("✅ Admin user created:", admin.email, "| Username:", admin.username);

  // Create 10 sample villas (V-001 to V-010)
  const villas = [];
  for (let i = 1; i <= 10; i++) {
    const villaNumber = `V-${String(i).padStart(3, "0")}`;
    const block = i <= 5 ? "A" : "B";
    
    const villa = await prisma.villa.upsert({
      where: {
        societyId_villaNumber: {
          societyId: society.id,
          villaNumber: villaNumber,
        },
      },
      update: {},
      create: {
        societyId: society.id,
        villaNumber: villaNumber,
        floors: Math.floor(Math.random() * 2) + 2, // 2-3 floors
        area: 1500 + (i * 100), // 1600-2500 sq ft
        block: block,
        ownerName: `Owner ${i}`,
        ownerEmail: `owner${i}@example.com`,
        ownerPhone: `+91 98765432${String(i).padStart(2, "0")}`,
        monthlyMaintenance: 5000 + (i * 500), // 5500-10000
      },
    });

    villas.push(villa);
    console.log(`✅ Villa created: ${villa.villaNumber} (Block ${villa.block})`);
  }

  // Create 3 gates
  const gates = [];
  const gateNames = ["Main Gate", "Secondary Gate", "Service Gate"];
  const gateLocations = ["North Entrance", "South Entrance", "East Service Entry"];

  for (let i = 0; i < 3; i++) {
    const gate = await prisma.gate.upsert({
      where: {
        id: `gate-${i + 1}`,
      },
      update: {},
      create: {
        id: `gate-${i + 1}`,
        societyId: society.id,
        name: gateNames[i],
        location: gateLocations[i],
        isActive: true,
      },
    });

    gates.push(gate);
    console.log(`✅ Gate created: ${gate.name}`);
  }

  // Create 3 guard users (one for each gate)
  const guards = [];
  for (let i = 1; i <= 3; i++) {
    const guardPasswordHash = await bcrypt.hash(guardPassword, 10);
    
    const guard = await prisma.user.upsert({
      where: { email: `guard${i}@society.local` },
      update: {
        passwordHash: guardPasswordHash,
        societyId: society.id,
        isActive: true,
      },
      create: {
        societyId: society.id,
        username: `guard${i}`,
        name: `Security Guard ${i}`,
        email: `guard${i}@society.local`,
        passwordHash: guardPasswordHash,
        role: "GUARD",
        phone: `+91 98765400${i}0`,
        isActive: true,
      },
    });

    guards.push(guard);
    
    // Assign guard to gate (1:1)
    await prisma.gate.update({
      where: { id: gates[i - 1].id },
      data: { assignedGuardId: guard.id },
    });

    console.log(`✅ Guard ${i} created (Username: guard${i}) and assigned to ${gates[i - 1].name}`);
  }

  // Create sample residents for first 3 villas
  for (let i = 1; i <= 3; i++) {
    const residentPasswordHash = await bcrypt.hash(residentPassword, 10);
    
    // Owner as resident
    const resident = await prisma.user.create({
      data: {
        societyId: society.id,
        villaId: villas[i - 1].id,
        username: `resident${i}`,
        name: `Resident Owner ${i}`,
        email: `resident${i}@example.com`,
        passwordHash: residentPasswordHash,
        role: "RESIDENT",
        phone: `+91 97654321${String(i).padStart(2, "0")}`,
        moveInDate: new Date("2023-01-01"),
        isActive: true,
      },
    });

    console.log(`✅ Resident created for ${villas[i - 1].villaNumber} (Username: resident${i})`);

    // Add a renter for villa 1
    if (i === 1) {
      const renter = await prisma.user.create({
        data: {
          societyId: society.id,
          villaId: villas[0].id,
          username: "tenant1",
          name: "Tenant Smith",
          email: "tenant1@example.com",
          passwordHash: residentPasswordHash,
          role: "RESIDENT",
          phone: "+91 9765432199",
          moveInDate: new Date("2024-01-01"),
          isActive: true,
        },
      });

      console.log(`✅ Tenant created for ${villas[0].villaNumber} (Username: tenant1)`);
    }
  }

  // Create RWA bank account
  const bankAccount = await prisma.bankAccount.create({
    data: {
      societyId: society.id,
      bankName: "State Bank of India",
      accountNumber: "1234567890",
      ifscCode: "SBIN0001234",
      accountHolderName: "Green Valley RWA",
      accountType: "Current",
      isActive: true,
    },
  });

  console.log("✅ Bank account created:", bankAccount.bankName);

  // Create maintenance bills for all villas (current month)
  const currentDate = new Date();
  const currentMonth = currentDate.getMonth() + 1;
  const currentYear = currentDate.getFullYear();
  
  for (const villa of villas) {
    await prisma.maintenance.create({
      data: {
        societyId: society.id,
        villaId: villa.id,
        month: currentMonth,
        year: currentYear,
        amount: villa.monthlyMaintenance,
        dueDate: new Date(currentYear, currentMonth - 1, 5), // 5th of current month
        status: "PENDING",
      },
    });
  }

  console.log(`✅ Maintenance bills created for ${villas.length} villas`);

  // Create sample payment for villa 1
  await prisma.maintenancePayment.create({
    data: {
      societyId: society.id,
      villaId: villas[0].id,
      month: currentMonth,
      year: currentYear,
      amount: villas[0].monthlyMaintenance,
      paymentDate: new Date(),
      paymentMode: "UPI",
      transactionId: "UPI1234567890",
      receiptNumber: `RCP${currentYear}${String(currentMonth).padStart(2, "0")}001`,
      bankAccountId: bankAccount.id,
      remarks: "Paid on time",
    },
  });

  // Update maintenance status
  await prisma.maintenance.update({
    where: {
      villaId_month_year: {
        villaId: villas[0].id,
        month: currentMonth,
        year: currentYear,
      },
    },
    data: { status: "PAID" },
  });

  console.log("✅ Sample payment created for V-001");

  console.log("\n🎉 Seed completed successfully!");
  console.log("\n📊 Summary:");
  console.log(`- 1 Society: ${society.name}`);
  console.log(`- 1 Admin: ${admin.email}`);
  console.log(`- ${villas.length} Villas (V-001 to V-010)`);
  console.log(`- ${gates.length} Gates with assigned guards`);
  console.log(`- ${guards.length} Guards`);
  console.log("- 4 Residents (3 owners + 1 tenant)");
  console.log(`- 1 Bank Account`);
  console.log(`- ${villas.length} Maintenance bills`);
  console.log("- 1 Sample payment");
  console.log("\n🔐 Login Credentials:");
  console.log(`Admin: ${adminEmail} / (set via DEMO_ADMIN_PASSWORD)`);
  console.log("Guard1: guard1@society.local / (set via DEMO_GUARD_PASSWORD)");
  console.log("Resident1: resident1@example.com / (set via DEMO_RESIDENT_PASSWORD)");
}

main()
  .catch((e) => {
    console.error("❌ Error during seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
