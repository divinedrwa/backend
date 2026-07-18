/**
 * Phase 0 (J1): dedicated QA sandbox society for local / staging validation.
 * Never run against production — guarded by scripts/guard-local-db.ts.
 *
 * Usage (from backend/, after local migrate):
 *   npm run prisma:seed-sandbox
 *
 * Credentials (override via env):
 *   SANDBOX_ADMIN_USER / SANDBOX_ADMIN_PASS  — default sandbox_admin / Sandbox123!
 *   SANDBOX_GUARD_USER / SANDBOX_GUARD_PASS  — default sandbox_guard / Sandbox123!
 *   SANDBOX_RESIDENT_USER / SANDBOX_RESIDENT_PASS — default sandbox_resident / Sandbox123!
 */
import path from "path";
import dotenv from "dotenv";
import { PrismaClient, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { societyIsSandboxColumnExists } from "../src/lib/sandboxSociety";

dotenv.config();
if (process.env.SKIP_ENV_LOCAL !== "1") {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });
}

const prisma = new PrismaClient();

const SOCIETY_ID = "qa-sandbox-society";

async function main() {
  const hasSandboxFlag = await societyIsSandboxColumnExists();
  if (!hasSandboxFlag) {
    console.error(
      "❌ Society.isSandbox column missing. Run: npm run prisma:migrate:local",
    );
    process.exit(1);
  }

  const adminUser = (process.env.SANDBOX_ADMIN_USER ?? "sandbox_admin").trim();
  const adminPass = (process.env.SANDBOX_ADMIN_PASS ?? "Sandbox123!").trim();
  const guardUser = (process.env.SANDBOX_GUARD_USER ?? "sandbox_guard").trim();
  const guardPass = (process.env.SANDBOX_GUARD_PASS ?? "Sandbox123!").trim();
  const residentUser = (process.env.SANDBOX_RESIDENT_USER ?? "sandbox_resident").trim();
  const residentPass = (process.env.SANDBOX_RESIDENT_PASS ?? "Sandbox123!").trim();

  console.log("🌱 Sandbox society seed (Phase 0 J1)…");

  const society = await prisma.society.upsert({
    where: { id: SOCIETY_ID },
    update: {
      name: "QA Sandbox Society",
      isSandbox: true,
      status: "ACTIVE",
      archivedAt: null,
    },
    create: {
      id: SOCIETY_ID,
      name: "QA Sandbox Society",
      address: "Local dev only — not for production residents",
      isSandbox: true,
    },
  });

  const passwordHash = async (plain: string) => bcrypt.hash(plain, 10);

  const admin = await prisma.user.upsert({
    where: { email: "sandbox-admin@qa.local" },
    update: {
      username: adminUser,
      passwordHash: await passwordHash(adminPass),
      societyId: society.id,
      role: UserRole.ADMIN,
      isActive: true,
    },
    create: {
      societyId: society.id,
      username: adminUser,
      name: "Sandbox Admin",
      email: "sandbox-admin@qa.local",
      passwordHash: await passwordHash(adminPass),
      role: UserRole.ADMIN,
      isActive: true,
    },
  });

  const guard = await prisma.user.upsert({
    where: { email: "sandbox-guard@qa.local" },
    update: {
      username: guardUser,
      passwordHash: await passwordHash(guardPass),
      societyId: society.id,
      role: UserRole.GUARD,
      isActive: true,
    },
    create: {
      societyId: society.id,
      username: guardUser,
      name: "Sandbox Guard",
      email: "sandbox-guard@qa.local",
      passwordHash: await passwordHash(guardPass),
      role: UserRole.GUARD,
      isActive: true,
    },
  });

  const villa = await prisma.villa.upsert({
    where: {
      societyId_villaNumber: { societyId: society.id, villaNumber: "SB-01" },
    },
    update: {},
    create: {
      societyId: society.id,
      villaNumber: "SB-01",
      block: "Sandbox",
      floors: 1,
      ownerName: "Sandbox Owner",
      monthlyMaintenance: 1500,
    },
  });

  const resident = await prisma.user.upsert({
    where: { email: "sandbox-resident@qa.local" },
    update: {
      username: residentUser,
      passwordHash: await passwordHash(residentPass),
      societyId: society.id,
      role: UserRole.RESIDENT,
      villaId: villa.id,
      isActive: true,
    },
    create: {
      societyId: society.id,
      username: residentUser,
      name: "Sandbox Resident",
      email: "sandbox-resident@qa.local",
      passwordHash: await passwordHash(residentPass),
      role: UserRole.RESIDENT,
      villaId: villa.id,
      isActive: true,
    },
  });

  // Minimal gate for visitor smoke
  await prisma.gate.upsert({
    where: { id: `${SOCIETY_ID}-main-gate` },
    update: {},
    create: {
      id: `${SOCIETY_ID}-main-gate`,
      societyId: society.id,
      name: "Main Gate",
      location: "Sandbox entrance",
    },
  });

  console.log("✅ Sandbox society ready");
  console.log(`   Society: ${society.name} (${society.id}) isSandbox=true`);
  console.log(`   Admin:    ${admin.username} / ${adminPass}`);
  console.log(`   Guard:    ${guard.username} / ${guardPass}`);
  console.log(`   Resident: ${resident.username} / ${residentPass} (villa ${villa.villaNumber})`);
  console.log("");
  console.log("   Point Flutter at local API (API_HOST) and log in as sandbox users.");
  console.log("   Use Razorpay rzp_test_* and PhonePe SANDBOX keys only on this society.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
