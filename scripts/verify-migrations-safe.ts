/**
 * Fails if Prisma migration SQL contains patterns that typically delete **all rows**
 * or drop entire tables (production data loss).
 *
 * Safe operations like DROP INDEX, DROP CONSTRAINT, ALTER ... DROP DEFAULT are allowed.
 *
 *   cd backend && npm run verify:migrations-safe
 *
 * To intentionally allow a reviewed destructive migration, add the migration folder name to
 * `scripts/migrations-safe-allowlist.json` (team review required — document why).
 */
import fs from "fs";
import path from "path";

const MIGRATIONS_ROOT = path.join(__dirname, "../prisma/migrations");
const ALLOWLIST_PATH = path.join(__dirname, "migrations-safe-allowlist.json");

type Allowlist = { allowDestructiveInMigrations?: string[] };

function loadAllowlist(): Set<string> {
  try {
    const raw = fs.readFileSync(ALLOWLIST_PATH, "utf8");
    const j = JSON.parse(raw) as Allowlist;
    return new Set(j.allowDestructiveInMigrations ?? []);
  } catch {
    return new Set();
  }
}

/** Remove `-- …` line comments (simple; does not handle quoted `--`). */
function stripSqlLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

const RULES: Array<{ name: string; test: (s: string) => boolean; hint: string }> = [
  {
    name: "DROP TABLE",
    test: (s) => /\bDROP\s+TABLE\b/i.test(s),
    hint: "Dropping a table deletes its schema and all rows. Prefer additive migrations or rename/archive flows reviewed by the team.",
  },
  {
    name: "TRUNCATE",
    test: (s) => /\bTRUNCATE\b/i.test(s),
    hint: "TRUNCATE removes all rows. Never use for routine schema migrations.",
  },
];

function listMigrationDirs(): string[] {
  if (!fs.existsSync(MIGRATIONS_ROOT)) return [];
  return fs
    .readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => /^\d{14}_/.test(name))
    .sort();
}

function main(): void {
  const allowlisted = loadAllowlist();
  const failures: string[] = [];

  for (const dirName of listMigrationDirs()) {
    const migrationSql = path.join(MIGRATIONS_ROOT, dirName, "migration.sql");
    if (!fs.existsSync(migrationSql)) continue;

    const raw = fs.readFileSync(migrationSql, "utf8");
    const body = stripSqlLineComments(raw);

    if (allowlisted.has(dirName)) {
      continue;
    }

    for (const rule of RULES) {
      if (rule.test(body)) {
        failures.push(
          `${migrationSql}: forbidden pattern "${rule.name}" — ${rule.hint}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error("Migration safety check failed (data-destructive SQL detected):\n");
    for (const f of failures) console.error(`  • ${f}`);
    console.error(
      `\nNormal migrations use CREATE/ALTER and preserve existing rows. Do not add DROP TABLE or TRUNCATE unless restoring from backup is planned.`,
    );
    console.error(
      `If a migration was reviewed and must contain DROP TABLE/TRUNCATE, add its folder name to scripts/migrations-safe-allowlist.json.`,
    );
    process.exit(1);
  }

  console.log(
    `OK: no DROP TABLE / TRUNCATE in ${listMigrationDirs().length} migration folders (allowlist: ${allowlisted.size}).`,
  );
}

main();
