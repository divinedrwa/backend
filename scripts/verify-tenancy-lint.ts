/**
 * E3 — Static tenancy lint: tenant route handlers should reference societyId from req.auth.
 * Heuristic scan; not a substitute for integration tests.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(__dirname, "../src/modules");

const SKIP_FILES = new Set([
  "auth/routes.ts",
  "public/routes.ts",
  "super/routes.ts",
  "legal/routes.ts",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const violations: string[] = [];

for (const file of walk(MODULES)) {
  const rel = path.relative(MODULES, file).replace(/\\/g, "/");
  if (SKIP_FILES.has(rel)) continue;
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes("requireAuth") && !src.includes("req.auth")) continue;
  if (src.includes("prisma.") && !src.includes("societyId") && !src.includes("SUPER_ADMIN")) {
    violations.push(rel);
  }
}

if (violations.length > 0) {
  console.error("E3 tenancy lint: files with prisma but no societyId reference:\n");
  for (const v of violations) console.error(`  • ${v}`);
  process.exit(1);
}

console.log("E3 tenancy lint OK");
