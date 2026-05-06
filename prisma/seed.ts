/**
 * Default seed: **one society + one admin** for empty databases (`npm run prisma:seed`).
 *
 * For full demo data (villas, guards, residents, …) use:
 *   npm run prisma:seed-demo
 */
import "dotenv/config";
import { PrismaClient, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@society.local").trim();
const adminPassword = (process.env.ADMIN_PASSWORD ?? "ChangeMe123!").trim();
const adminUsername = (process.env.ADMIN_USERNAME ?? "admin").trim();
const societyName = (process.env.SOCIETY_NAME ?? "Default Society").trim();

async function main() {
  console.log("🌱 Minimal seed (admin only)…");

  const reservedSuperUsername = (
    process.env.SUPER_ADMIN_USERNAME?.trim() ?? "super_admin"
  ).toLowerCase();
  if (adminUsername.toLowerCase() === reservedSuperUsername) {
    console.warn(
      `⚠️  ADMIN_USERNAME cannot equal SUPER_ADMIN_USERNAME ("${adminUsername}"). Society admin login will conflict with platform super admin — set ADMIN_USERNAME=e.g. society_admin or change SUPER_ADMIN_USERNAME.`,
    );
  }

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

  let superEmailEnv = process.env.SUPER_ADMIN_EMAIL?.trim();
  let superPasswordEnv = process.env.SUPER_ADMIN_PASSWORD?.trim();

  const autoSeed =
    process.env.SUPER_ADMIN_AUTO_SEED === "true" || process.env.SUPER_ADMIN_AUTO_SEED === "1";
  if ((!superEmailEnv || !superPasswordEnv) && autoSeed) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "❌ SUPER_ADMIN_AUTO_SEED is set but NODE_ENV=production. Unset SUPER_ADMIN_AUTO_SEED or set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD explicitly.",
      );
      process.exit(1);
    }
    superEmailEnv = superEmailEnv || "superadmin@platform.local";
    superPasswordEnv = superPasswordEnv || "SuperAdminChangeMe123!";
    console.warn(
      "⚠️  SUPER_ADMIN_AUTO_SEED: filling missing SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD with local defaults (change via env before sharing any database).",
    );
  }

  if (superEmailEnv && superPasswordEnv) {
    const superUsername = process.env.SUPER_ADMIN_USERNAME?.trim() ?? "super_admin";
    const superName = process.env.SUPER_ADMIN_NAME?.trim() ?? "Platform Super Admin";
    const hash = await bcrypt.hash(superPasswordEnv, 10);

    const superData = {
      username: superUsername,
      name: superName,
      passwordHash: hash,
      role: UserRole.SUPER_ADMIN,
      societyId: null as string | null,
      isActive: true,
    };

    // Avoid P2002 when username `super_admin` already exists under another email (e.g. prior auto-seed).
    const byEmail = await prisma.user.findUnique({ where: { email: superEmailEnv } });
    if (byEmail) {
      await prisma.user.update({ where: { id: byEmail.id }, data: superData });
    } else {
      const byUsername = await prisma.user.findFirst({
        where: { username: { equals: superUsername, mode: "insensitive" } },
      });
      if (byUsername) {
        await prisma.user.update({
          where: { id: byUsername.id },
          data: { ...superData, email: superEmailEnv },
        });
      } else {
        await prisma.user.create({
          data: {
            email: superEmailEnv,
            ...superData,
          },
        });
      }
    }

    console.log(`   Super:   ${superEmailEnv} (SUPER_ADMIN, no society)`);
    console.log(`            Login: username "${superUsername}" or email "${superEmailEnv}" + SUPER_ADMIN_PASSWORD`);
  } else {
    console.warn(
      "   Super admin skipped — set SUPER_ADMIN_EMAIL + SUPER_ADMIN_PASSWORD, or add SUPER_ADMIN_AUTO_SEED=true for local defaults (non-production only), then run npm run prisma:seed.",
    );
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
