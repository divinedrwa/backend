/**
 * Read-only counts per society (users, residents, villas) — debug "empty dashboard".
 *
 *   cd backend && npm run diagnose:db
 */
import "dotenv/config";
import { PrismaClient, UserRole } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const societies = await prisma.society.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      status: true,
    },
  });

  console.log(`DATABASE_URL host: ${process.env.DATABASE_URL.replace(/:[^:@]+@/, ":****@")}`);
  console.log(`Societies: ${societies.length}\n`);

  for (const s of societies) {
    const totalUsers = await prisma.user.count({ where: { societyId: s.id } });
    const residents = await prisma.user.count({
      where: { societyId: s.id, role: UserRole.RESIDENT },
    });
    const admins = await prisma.user.count({
      where: { societyId: s.id, role: UserRole.ADMIN },
    });
    const villas = await prisma.villa.count({ where: { societyId: s.id } });

    console.log(`${s.name}`);
    console.log(`  id:        ${s.id}`);
    console.log(`  users:     ${totalUsers} (residents: ${residents}, admins: ${admins})`);
    console.log(`  villas:    ${villas}`);
    console.log("");
  }

  const superAdmins = await prisma.user.count({
    where: { role: UserRole.SUPER_ADMIN },
  });
  console.log(`SUPER_ADMIN users (no society): ${superAdmins}`);
  console.log(
    "\nTip: Society dashboard lists only rows where User.societyId matches your logged-in admin JWT.",
  );
  console.log(
    "If counts are 0 here, data was likely wiped (see db:wipe-admin) or you are connected to a different/empty database branch.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
