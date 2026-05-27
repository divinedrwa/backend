/**
 * Read-only check for columns/tables that cause P2022 or maintenance 500s when missing.
 *
 *   cd backend && npm run diagnose:schema-drift
 *
 * If migrate deploy says "No pending migrations" but this reports FAIL, run:
 *   npm run prisma:migrate:deploy   (after deploying migration 20260528140000_repair_baselined_schema_drift)
 * or paste prisma/migrations/20260528140000_repair_baselined_schema_drift/migration.sql in the DB SQL console.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type Check = { label: string; ok: boolean; detail?: string };

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${table}
        AND column_name = ${column}
    ) AS "exists"
  `;
  return Boolean(rows[0]?.exists);
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ${table}
    ) AS "exists"
  `;
  return Boolean(rows[0]?.exists);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const masked = process.env.DATABASE_URL.replace(/:[^:@]+@/, ":****@");
  console.log(`DATABASE_URL: ${masked}\n`);

  const checks: Check[] = [];

  const columnChecks: Array<[string, string]> = [
    ["Visitor", "photoUrl"],
    ["Visitor", "checkedInByGuardId"],
    ["Visitor", "checkedOutByGuardId"],
    ["Visitor", "preApprovedId"],
    ["User", "maintenanceBillingRole"],
    ["VillaMaintenanceSnapshot", "lateFeeAmount"],
    ["VillaMaintenanceSnapshot", "lateFeeAppliedAt"],
    ["Society", "lateFeePercentage"],
    ["Society", "maintenanceGracePeriodDays"],
  ];

  for (const [table, column] of columnChecks) {
    const ok = await columnExists(table, column);
    checks.push({
      label: `${table}.${column}`,
      ok,
      detail: ok ? undefined : "MISSING",
    });
  }

  const tableChecks = ["VisitorCheckpoint", "SOSCheckpoint", "SOSEscalation", "user_payments"];
  for (const table of tableChecks) {
    const ok = await tableExists(table);
    checks.push({
      label: `table ${table}`,
      ok,
      detail: ok ? undefined : "MISSING",
    });
  }

  const applied = await prisma.$queryRaw<
    { migration_name: string; finished_at: Date | null }[]
  >`
    SELECT migration_name, finished_at
    FROM "_prisma_migrations"
    WHERE migration_name LIKE '%visitor_checkpoint%'
       OR migration_name LIKE '%repair_baselined%'
    ORDER BY finished_at DESC NULLS LAST
  `;

  console.log("Schema checks:");
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? "OK" : "FAIL";
    if (!c.ok) failed += 1;
    console.log(`  [${mark}] ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  }

  console.log("\nRelated _prisma_migrations rows:");
  if (applied.length === 0) {
    console.log("  (none matching visitor_checkpoint / repair_baselined)");
  } else {
    for (const row of applied) {
      console.log(`  - ${row.migration_name} finished_at=${row.finished_at ?? "NULL"}`);
    }
  }

  if (failed > 0) {
    console.log(
      "\nDrift detected: Prisma history may show applied while DDL was never run.",
    );
    console.log(
      "Fix: deploy backend with migration 20260528140000_repair_baselined_schema_drift,",
    );
    console.log(
      "then `npm run prisma:migrate:deploy` against production DATABASE_URL.",
    );
    console.log(
      "Or run migration.sql from that folder in Neon/Render SQL editor (idempotent).",
    );
    process.exit(1);
  }

  console.log("\nAll critical schema objects present.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
