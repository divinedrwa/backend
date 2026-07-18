/**
 * Generate typed guard API path constants for divine_app from mobile manifest.
 *
 * Usage: npm run openapi:generate-guard-paths
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOBILE_API_CASES } from "./mobile-api/manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(
  __dirname,
  "../../divine_app/lib/features/guard/data/guard_api_paths.generated.dart",
);

function toConstName(method: string, apiPath: string): string {
  const cleaned = apiPath
    .replace(/^\//, "")
    .replace(/[:/]/g, "_")
    .replace(/-/g, "_")
    .replace(/__+/g, "_");
  return `${method.toLowerCase()}_${cleaned}`;
}

function main() {
  const guardCases = MOBILE_API_CASES.filter((c) => c.path.startsWith("/guards/"));
  const lines = [
    "// GENERATED — do not edit. Run: cd backend && npm run openapi:generate-guard-paths",
    "",
    "/// Guard module API paths (synced with backend/scripts/mobile-api/manifest.ts).",
    "abstract final class GuardApiPaths {",
  ];

  const seen = new Set<string>();
  for (const c of guardCases) {
    const name = toConstName(c.method, c.path);
    if (seen.has(name)) continue;
    seen.add(name);
    lines.push(`  static const String ${name} = '${c.path}';`);
  }

  lines.push("}", "");

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${lines.join("\n")}\n`);
  console.log(`Wrote ${OUT} (${seen.size} paths)`);
}

main();
