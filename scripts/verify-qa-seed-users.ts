/**
 * Verifies prisma/seed.ts QA accounts against DATABASE_URL (backend/.env).
 * Guard: guard1 / guard123 — Resident: resident1 / resident123
 *
 * Overrides: QA_GUARD_USERNAME, QA_GUARD_PASSWORD, QA_RESIDENT_USERNAME, QA_RESIDENT_PASSWORD
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient, type UserRole } from "@prisma/client";

const prisma = new PrismaClient();

async function verifyUser(
  label: string,
  username: string,
  password: string,
  expectedRole: UserRole,
): Promise<void> {
  const u = await prisma.user.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
  });

  if (!u) {
    console.error(
      `${label} "${username}" not found. Run: cd backend && npm run prisma:seed`,
    );
    process.exit(1);
  }
  if (u.role !== expectedRole) {
    console.error(`${label} "${username}" has role ${u.role}, expected ${expectedRole}.`);
    process.exit(1);
  }
  const ok = await bcrypt.compare(password, u.passwordHash);
  if (!ok) {
    console.error(`${label} password mismatch for "${username}".`);
    process.exit(1);
  }
  console.log(`${label} OK: ${u.username} (${u.email})`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL missing — configure backend/.env");
    process.exit(1);
  }

  const gUser = (process.env.QA_GUARD_USERNAME ?? "guard1").trim();
  const gPass = (process.env.QA_GUARD_PASSWORD ?? "guard123").trim() || "guard123";
  const rUser = (process.env.QA_RESIDENT_USERNAME ?? "resident1").trim();
  const rPass = (process.env.QA_RESIDENT_PASSWORD ?? "resident123").trim() || "resident123";

  await verifyUser("QA guard", gUser, gPass, "GUARD");
  await verifyUser("QA resident", rUser, rPass, "RESIDENT");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
