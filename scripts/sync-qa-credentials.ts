/**
 * Aligns QA passwords (guard/resident); creates a minimal QA resident only if missing.
 * Defaults match verify-qa-seed-users.ts: guard1/guard123, resident1/resident123.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient, UserRole } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL missing — configure backend/.env");
    process.exit(1);
  }

  const gUser = (process.env.QA_GUARD_USERNAME ?? "guard1").trim();
  const gPass = (process.env.QA_GUARD_PASSWORD ?? "guard123").trim() || "guard123";
  const rUser = (process.env.QA_RESIDENT_USERNAME ?? "resident1").trim();
  const rPass = (process.env.QA_RESIDENT_PASSWORD ?? "resident123").trim() || "resident123";

  const guardHash = await bcrypt.hash(gPass, 10);
  const resHash = await bcrypt.hash(rPass, 10);

  const gCount = await prisma.user.updateMany({
    where: {
      username: { equals: gUser, mode: "insensitive" },
      role: UserRole.GUARD,
    },
    data: { passwordHash: guardHash },
  });

  const rCount = await prisma.user.updateMany({
    where: {
      username: { equals: rUser, mode: "insensitive" },
      role: UserRole.RESIDENT,
    },
    data: { passwordHash: resHash },
  });

  console.log(`QA credentials sync: GUARD rows=${gCount.count}, RESIDENT rows=${rCount.count}`);
  if (gCount.count === 0) {
    console.warn(`No GUARD user matched username "${gUser}"`);
  }

  if (rCount.count === 0) {
    const stillMissing = !(await prisma.user.findFirst({
      where: { username: { equals: rUser, mode: "insensitive" }, role: UserRole.RESIDENT },
    }));
    if (stillMissing) {
      const villa = await prisma.villa.findFirst({ orderBy: { id: "asc" } });
      if (!villa) {
        console.warn(`No RESIDENT "${rUser}" and no Villa row — cannot auto-create QA resident`);
      } else {
        const email = `qa-${rUser}@local.test`;
        await prisma.user.upsert({
          where: { email },
          update: {
            username: rUser,
            passwordHash: resHash,
            role: UserRole.RESIDENT,
            societyId: villa.societyId,
            villaId: villa.id,
            isActive: true,
          },
          create: {
            email,
            username: rUser,
            name: "QA Resident",
            passwordHash: resHash,
            role: UserRole.RESIDENT,
            societyId: villa.societyId,
            villaId: villa.id,
            isActive: true,
          },
        });
        console.log(`Created/updated QA resident "${rUser}" on villa ${villa.id}`);
      }
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
