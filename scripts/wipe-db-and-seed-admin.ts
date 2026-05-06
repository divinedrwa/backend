/**
 * DANGER: Truncates **all** public tables (except Prisma migration history) and inserts
 * one society + one ADMIN user for a clean admin-dashboard setup.
 *
 *   CONFIRM_DB_WIPE=1 npm run db:wipe-admin
 *
 * Defaults (override with env):
 *   ADMIN_EMAIL=admin@society.local
 *   ADMIN_PASSWORD=ChangeMe123!
 *   ADMIN_USERNAME=admin
 *   SOCIETY_NAME=Default Society
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@society.local").trim();
const adminPassword = (process.env.ADMIN_PASSWORD ?? "ChangeMe123!").trim();
const adminUsername = (process.env.ADMIN_USERNAME ?? "admin").trim();
const societyName = (process.env.SOCIETY_NAME ?? "Default Society").trim();

async function truncateAllApplicationData(): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('_prisma_migrations')
    ORDER BY tablename
  `;
  if (rows.length === 0) {
    return;
  }
  const list = rows
    .map((r) => {
      const t = r.tablename.replace(/"/g, '""');
      return `"public"."${t}"`;
    })
    .join(", ");
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
}

async function main() {
  if (process.env.CONFIRM_DB_WIPE !== "1") {
    console.error(
      "Refusing to wipe the database. Run:\n" +
        "  CONFIRM_DB_WIPE=1 npm run db:wipe-admin",
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (backend/.env).");
    process.exit(1);
  }

  console.log("Truncating all application tables…");
  await truncateAllApplicationData();

  const passwordHash = await bcrypt.hash(adminPassword, 10);

  const society = await prisma.society.create({
    data: {
      name: societyName,
      address: null,
    },
  });

  await prisma.user.create({
    data: {
      societyId: society.id,
      username: adminUsername,
      name: "Administrator",
      email: adminEmail,
      passwordHash,
      role: "ADMIN",
      isActive: true,
    },
  });

  console.log("\n✅ Database wiped and admin created.");
  console.log(`   Society: ${society.name} (${society.id})`);
  console.log(`   Login:   ${adminEmail}`);
  console.log(`   Username:${adminUsername}`);
  console.log("   Password: (set via ADMIN_PASSWORD)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
