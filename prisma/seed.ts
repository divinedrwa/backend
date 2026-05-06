/**
 * Default seed: **one society + one admin** for empty databases (`npm run prisma:seed`).
 *
 * For full demo data (villas, guards, residents, …) use:
 *   npm run prisma:seed-demo
 */
import { PrismaClient, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@society.local").trim();
const adminPassword = (process.env.ADMIN_PASSWORD ?? "ChangeMe123!").trim();
const adminUsername = (process.env.ADMIN_USERNAME ?? "admin").trim();
const societyName = (process.env.SOCIETY_NAME ?? "Default Society").trim();

async function main() {
  console.log("🌱 Minimal seed (admin only)…");

  const society = await prisma.society.upsert({
    where: { id: "default-society" },
    update: {
      name: societyName,
    },
    create: {
      id: "default-society",
      name: societyName,
      address: null,
    },
  });

  const passwordHash = await bcrypt.hash(adminPassword, 10);

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      username: adminUsername,
      name: "Administrator",
      passwordHash,
      role: UserRole.ADMIN,
      societyId: society.id,
      isActive: true,
    },
    create: {
      societyId: society.id,
      username: adminUsername,
      name: "Administrator",
      email: adminEmail,
      passwordHash,
      role: UserRole.ADMIN,
      isActive: true,
    },
  });

  console.log("✅ Done.");
  console.log(`   Society: ${society.name}`);
  console.log(`   Admin:   ${adminEmail} / ${adminUsername}`);

  const superEmailEnv = process.env.SUPER_ADMIN_EMAIL?.trim();
  const superPasswordEnv = process.env.SUPER_ADMIN_PASSWORD?.trim();
  if (superEmailEnv && superPasswordEnv) {
    const hash = await bcrypt.hash(superPasswordEnv, 10);
    await prisma.user.upsert({
      where: { email: superEmailEnv },
      update: {
        username: process.env.SUPER_ADMIN_USERNAME?.trim() ?? "super_admin",
        name: process.env.SUPER_ADMIN_NAME?.trim() ?? "Platform Super Admin",
        passwordHash: hash,
        role: UserRole.SUPER_ADMIN,
        societyId: null,
        isActive: true,
      },
      create: {
        username: process.env.SUPER_ADMIN_USERNAME?.trim() ?? "super_admin",
        name: process.env.SUPER_ADMIN_NAME?.trim() ?? "Platform Super Admin",
        email: superEmailEnv,
        passwordHash: hash,
        role: UserRole.SUPER_ADMIN,
        societyId: null,
        isActive: true,
      },
    });
    console.log(`   Super:   ${superEmailEnv} (SUPER_ADMIN, no society)`);
  }
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
