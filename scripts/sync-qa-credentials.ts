/**
 * Aligns QA users (guard/resident/admin) to an active society for local/mobile smoke.
 * Defaults: guard1/guard123, resident1/resident123, admin/ChangeMe123!
 *
 * Target society: QA_SOCIETY_ID env, else first ACTIVE society (matches public picker).
 */
import path from "path";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { PrismaClient, SocietyStatus, UserRole } from "@prisma/client";

// Match server startup (env.ts): .env then .env.local overrides.
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const prisma = new PrismaClient();

async function resolveTargetSocietyId(): Promise<string> {
  const fromEnv = process.env.QA_SOCIETY_ID?.trim();
  if (fromEnv) {
    const s = await prisma.society.findFirst({
      where: { id: fromEnv, archivedAt: null },
      select: { id: true, name: true, status: true },
    });
    if (!s) {
      throw new Error(`QA_SOCIETY_ID "${fromEnv}" not found`);
    }
    console.log(`Target society (env): ${s.name} (${s.id})`);
    return s.id;
  }

  // Mirror GET /api/public/societies ordering (name asc; ACTIVE before INACTIVE).
  const rows = await prisma.society.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true, status: true },
    orderBy: { name: "asc" },
  });
  const sorted = [...rows].sort((a, b) => {
    if (a.status === b.status) return a.name.localeCompare(b.name);
    return a.status === SocietyStatus.ACTIVE ? -1 : 1;
  });
  const s = sorted[0];
  if (!s) {
    throw new Error("No society in database — run prisma:seed or prisma:seed-demo");
  }
  console.log(`Target society (public picker #1): ${s.name} (${s.id})`);
  return s.id;
}

async function alignUser(opts: {
  username: string;
  passwordHash: string;
  role: UserRole;
  societyId: string;
  villaId?: string | null;
  fallbackEmail: string;
  displayName: string;
}): Promise<void> {
  const existing = await prisma.user.findFirst({
    where: {
      username: { equals: opts.username, mode: "insensitive" },
      role: opts.role,
    },
  });

  if (existing) {
    let villaId = opts.villaId ?? existing.villaId;
    if (opts.villaId && opts.villaId !== existing.villaId) {
      const taken = await prisma.user.findFirst({
        where: {
          villaId: opts.villaId,
          NOT: { id: existing.id },
        },
        select: { id: true },
      });
      if (taken) {
        villaId = existing.villaId;
      }
    }
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        passwordHash: opts.passwordHash,
        societyId: opts.societyId,
        villaId,
        isActive: true,
      },
    });
    console.log(`Updated ${opts.role} "${opts.username}" (${existing.email}) → society ${opts.societyId}`);
    return;
  }

  let villaId: string | null = opts.villaId ?? null;
  if (villaId) {
    const taken = await prisma.user.findFirst({
      where: { villaId },
      select: { id: true },
    });
    if (taken) {
      console.warn(`Villa ${villaId} occupied — ${opts.role} "${opts.username}" created without villaId`);
      villaId = null;
    }
  }

  await prisma.user.create({
    data: {
      email: opts.fallbackEmail,
      username: opts.username,
      name: opts.displayName,
      passwordHash: opts.passwordHash,
      role: opts.role,
      societyId: opts.societyId,
      villaId,
      isActive: true,
    },
  });
  console.log(`Created ${opts.role} "${opts.username}" → society ${opts.societyId}`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL missing — configure backend/.env");
    process.exit(1);
  }

  const societyId = await resolveTargetSocietyId();

  const gUser = (process.env.QA_GUARD_USERNAME ?? "guard1").trim();
  const gPass = (process.env.QA_GUARD_PASSWORD ?? "guard123").trim() || "guard123";
  const rUser = (process.env.QA_RESIDENT_USERNAME ?? "resident1").trim();
  const rPass = (process.env.QA_RESIDENT_PASSWORD ?? "resident123").trim() || "resident123";
  const aUser = (process.env.QA_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? "admin").trim();
  const aPass =
    (process.env.QA_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "ChangeMe123!").trim() ||
    "ChangeMe123!";
  const aEmail = (process.env.QA_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? "admin@society.local").trim();

  const guardHash = await bcrypt.hash(gPass, 10);
  const resHash = await bcrypt.hash(rPass, 10);
  const adminHash = await bcrypt.hash(aPass, 10);

  await alignUser({
    username: gUser,
    passwordHash: guardHash,
    role: UserRole.GUARD,
    societyId,
    fallbackEmail: `qa-${gUser}@local.test`,
    displayName: "QA Guard",
  });

  const villas = await prisma.villa.findMany({
    where: { societyId },
    orderBy: { villaNumber: "asc" },
    select: { id: true, villaNumber: true },
  });
  let villa: { id: string; villaNumber: string } | null = null;
  for (const v of villas) {
    const occupied = await prisma.user.findFirst({
      where: {
        villaId: v.id,
        role: UserRole.RESIDENT,
        NOT: { username: { equals: rUser, mode: "insensitive" } },
      },
      select: { id: true },
    });
    if (!occupied) {
      villa = v;
      break;
    }
  }
  if (!villa && villas.length > 0) {
    villa = villas[0]!;
    console.warn(`All villas occupied — resident "${rUser}" keeps first villa ${villa.villaNumber}`);
  } else if (!villa) {
    console.warn(`No villa in society ${societyId} — resident may lack villaId`);
  }

  await alignUser({
    username: rUser,
    passwordHash: resHash,
    role: UserRole.RESIDENT,
    societyId,
    villaId: villa?.id ?? null,
    fallbackEmail: `qa-${rUser}@local.test`,
    displayName: "QA Resident",
  });

  // Ensure QA resident has a villa (required for resident API routes).
  const qaResident = await prisma.user.findFirst({
    where: {
      societyId,
      username: { equals: rUser, mode: "insensitive" },
      role: UserRole.RESIDENT,
    },
  });
  if (qaResident && !qaResident.villaId) {
    const freeVilla = await prisma.villa.findFirst({
      where: {
        societyId,
        users: { none: { role: UserRole.RESIDENT, isActive: true } },
      },
      orderBy: { villaNumber: "asc" },
      select: { id: true, villaNumber: true },
    });
    if (freeVilla) {
      await prisma.user.update({
        where: { id: qaResident.id },
        data: { villaId: freeVilla.id },
      });
      console.log(`Assigned villa ${freeVilla.villaNumber} to QA resident "${rUser}"`);
    } else {
      console.warn(`No free villa for QA resident "${rUser}" — assign a flat in admin`);
    }
  }

  // Re-link demo residents left without a villa (never evict an existing assignment).
  const orphanResidents = await prisma.user.findMany({
    where: {
      societyId,
      role: UserRole.RESIDENT,
      isActive: true,
      villaId: null,
    },
    select: { id: true, username: true, email: true },
    orderBy: { createdAt: "asc" },
  });
  for (const resident of orphanResidents) {
    const freeVilla = await prisma.villa.findFirst({
      where: {
        societyId,
        users: { none: { role: UserRole.RESIDENT, isActive: true } },
      },
      orderBy: { villaNumber: "asc" },
      select: { id: true, villaNumber: true },
    });
    if (!freeVilla) break;
    await prisma.user.update({
      where: { id: resident.id },
      data: { villaId: freeVilla.id },
    });
    console.log(
      `Assigned villa ${freeVilla.villaNumber} to resident ${resident.username ?? resident.email}`,
    );
  }

  const adminExisting = await prisma.user.findFirst({
    where: { email: { equals: aEmail, mode: "insensitive" } },
  });
  if (adminExisting) {
    await prisma.user.update({
      where: { id: adminExisting.id },
      data: {
        username: aUser,
        passwordHash: adminHash,
        role: UserRole.ADMIN,
        societyId,
        isActive: true,
      },
    });
    console.log(`Updated ADMIN "${aUser}" (${aEmail}) → society ${societyId}`);
  } else {
    const byUsername = await prisma.user.findFirst({
      where: {
        username: { equals: aUser, mode: "insensitive" },
        role: { in: [UserRole.ADMIN, UserRole.RESIDENT_CUM_ADMIN] },
      },
    });
    if (byUsername) {
      await prisma.user.update({
        where: { id: byUsername.id },
        data: { passwordHash: adminHash, societyId, isActive: true },
      });
      console.log(`Updated ADMIN "${aUser}" (${byUsername.email}) → society ${societyId}`);
    } else {
      await prisma.user.create({
        data: {
          email: aEmail,
          username: aUser,
          name: "QA Administrator",
          passwordHash: adminHash,
          role: UserRole.ADMIN,
          societyId,
          isActive: true,
        },
      });
      console.log(`Created ADMIN "${aUser}" (${aEmail}) → society ${societyId}`);
    }
  }

  console.log("\nQA login (pick this society in the app):");
  console.log(`  societyId: ${societyId}`);
  console.log(`  guard:    ${gUser} / ${gPass}`);
  console.log(`  resident: ${rUser} / ${rPass}`);
  console.log(`  admin:    ${aUser} / ${aPass}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
