/**
 * Lists platform super admin rows (diagnose login: role, societyId, username, email).
 *
 *   cd backend && npx tsx scripts/verify-super-admin.ts
 */
import { PrismaClient, UserRole } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.user.findMany({
    where: { role: UserRole.SUPER_ADMIN },
    select: {
      id: true,
      username: true,
      email: true,
      societyId: true,
      isActive: true,
      createdAt: true,
    },
  });

  if (rows.length === 0) {
    console.log("No SUPER_ADMIN users found. Set SUPER_ADMIN_EMAIL + SUPER_ADMIN_PASSWORD and run: npm run prisma:seed");
    return;
  }

  for (const u of rows) {
    const ok = u.societyId === null && u.isActive;
    console.log(
      `${ok ? "✓" : "✗"} ${u.username} <${u.email}>  societyId=${u.societyId ?? "null"}  active=${u.isActive}`,
    );
    if (!ok) {
      if (u.societyId !== null) {
        console.log(
          "   Fix: super admin must have societyId = null (run seed update or: UPDATE \"User\" SET \"societyId\" = NULL WHERE id = '...')",
        );
      }
      if (!u.isActive) {
        console.log('   Fix: set isActive = true for this user.');
      }
    }
  }

  console.log("\nSign in at POST /api/auth/super-admin/login with body:");
  console.log('  { "username": "<username or email above>", "password": "<SUPER_ADMIN_PASSWORD>" }');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
