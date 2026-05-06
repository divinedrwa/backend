/**
 * Runs read-only PostgreSQL checks for multi-tenant data integrity (societyId scoping).
 * Usage: cd backend && npx tsx src/scripts/validate-tenant-data.ts
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

type RowCount = { bad_rows: bigint };

const checks: { name: string; sql: Prisma.Sql; critical: boolean }[] = [
  {
    name: "User NULL societyId (non–SUPER_ADMIN)",
    sql: Prisma.sql`
      SELECT COUNT(*)::bigint AS bad_rows
      FROM "User"
      WHERE "societyId" IS NULL AND role::text IS DISTINCT FROM 'SUPER_ADMIN'
    `,
    critical: true,
  },
  {
    name: "Villa NULL societyId",
    sql: Prisma.sql`SELECT COUNT(*)::bigint AS bad_rows FROM "Villa" WHERE "societyId" IS NULL`,
    critical: true,
  },
  {
    name: "Visitor NULL societyId",
    sql: Prisma.sql`SELECT COUNT(*)::bigint AS bad_rows FROM "Visitor" WHERE "societyId" IS NULL`,
    critical: true,
  },
  {
    name: "Parcel NULL societyId",
    sql: Prisma.sql`SELECT COUNT(*)::bigint AS bad_rows FROM "Parcel" WHERE "societyId" IS NULL`,
    critical: true,
  },
  {
    name: "VisitorVilla visitor vs villa society mismatch",
    sql: Prisma.sql`
      SELECT COUNT(*)::bigint AS bad_rows
      FROM "VisitorVilla" vv
      INNER JOIN "Visitor" vi ON vi.id = vv."visitorId"
      INNER JOIN "Villa" vl ON vl.id = vv."villaId"
      WHERE vi."societyId" IS DISTINCT FROM vl."societyId"
    `,
    critical: true,
  },
  {
    name: "User villa society mismatch",
    sql: Prisma.sql`
      SELECT COUNT(*)::bigint AS bad_rows
      FROM "User" u
      INNER JOIN "Villa" vl ON vl.id = u."villaId"
      WHERE u."societyId" IS DISTINCT FROM vl."societyId"
    `,
    critical: true,
  },
  {
    name: "UserCyclePayment user vs BillingCycle society",
    sql: Prisma.sql`
      SELECT COUNT(*)::bigint AS bad_rows
      FROM "user_payments" ucp
      INNER JOIN "User" u ON u.id = ucp."userId"
      INNER JOIN "BillingCycle" bc ON bc.id = ucp."cycleId"
      WHERE u."societyId" IS DISTINCT FROM bc."societyId"
    `,
    critical: true,
  },
  {
    name: "payment_logs NULL societyId (informational)",
    sql: Prisma.sql`SELECT COUNT(*)::bigint AS bad_rows FROM "payment_logs" WHERE "societyId" IS NULL`,
    critical: false,
  },
];

async function main(): Promise<void> {
  let failed = false;
  for (const { name, sql, critical } of checks) {
    const [row] = (await prisma.$queryRaw(sql)) as RowCount[];
    const n = Number(row?.bad_rows ?? 0);
    const ok = n === 0;
    if (!ok && critical) failed = true;
    const label = critical ? (ok ? "PASS" : "FAIL") : ok ? "PASS" : "WARN";
    console.log(`${label} ${name}: ${n}`);
  }

  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  prisma.$disconnect().finally(() => process.exit(1));
});
