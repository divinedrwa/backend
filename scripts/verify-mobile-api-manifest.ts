/**
 * C6 — CI gate: divine_app ApiEndpoints must cover every path in mobile-api/manifest.ts.
 *
 * Usage: npm run verify:mobile-api-manifest
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOBILE_API_CASES } from "./mobile-api/manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DART_ENDPOINTS = path.join(
  ROOT,
  "divine_app/lib/core/constants/api_endpoints.dart",
);
const ALLOWLIST_PATH = path.join(__dirname, "mobile-api/dart-path-allowlist.json");

type Allowlist = { paths?: string[] };

/** Build match candidates: full path and prefixes up to each :param segment. */
function pathMatchCandidates(manifestPath: string): string[] {
  const segments = manifestPath.split("/").filter(Boolean);
  const candidates = new Set<string>();
  let built = "";
  for (const seg of segments) {
    if (seg.startsWith(":")) {
      if (built) candidates.add(built);
      continue;
    }
    built += `/${seg}`;
    candidates.add(built);
  }
  return [...candidates].sort((a, b) => b.length - a.length);
}

function loadAllowlist(): Set<string> {
  if (!fs.existsSync(ALLOWLIST_PATH)) return new Set();
  const raw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8")) as Allowlist;
  return new Set(raw.paths ?? []);
}

function main() {
  if (!fs.existsSync(DART_ENDPOINTS)) {
    console.error(`Missing ${DART_ENDPOINTS}`);
    process.exit(1);
  }
  const dart = fs.readFileSync(DART_ENDPOINTS, "utf8");
  const allowlist = loadAllowlist();
  const missing: Array<{ name: string; path: string; tried: string[] }> = [];

  for (const c of MOBILE_API_CASES) {
    if (allowlist.has(c.path)) continue;
    const candidates = pathMatchCandidates(c.path);
    const found = candidates.some((p) => dart.includes(p));
    if (!found) {
      missing.push({ name: c.name, path: c.path, tried: candidates });
    }
  }

  if (missing.length > 0) {
    console.error("C6 FAIL: manifest paths missing from api_endpoints.dart:\n");
    for (const m of missing) {
      console.error(`  • ${m.name}`);
      console.error(`    path: ${m.path}`);
      console.error(`    tried: ${m.tried.join(", ")}`);
    }
    console.error(
      `\nSync divine_app/lib/core/constants/api_endpoints.dart or add to ${ALLOWLIST_PATH}`,
    );
    process.exit(1);
  }

  console.log(
    `C6 OK: ${MOBILE_API_CASES.length} manifest paths covered (${allowlist.size} allowlisted)`,
  );
}

main();
