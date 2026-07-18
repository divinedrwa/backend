/**
 * CI gate: critical guard paths must appear in OpenAPI document (B4 v1 scope).
 *
 * Usage: npm run verify:openapi-guard
 */
import { generateOpenApiDocument } from "../src/lib/openapi.js";

/** Guard routes with typed clients — expand as OpenAPI coverage grows. */
const REQUIRED_GUARD_OPENAPI_PATHS = [
  "POST /api/guards/visitor-checkin",
  "POST /api/guards/visitor-checkout",
  "GET /api/guards/my-visitors",
  "GET /api/guards/my-dashboard",
] as const;

function main() {
  const doc = generateOpenApiDocument();
  const registered = new Set<string>();

  for (const [pathKey, methods] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(methods ?? {})) {
      registered.add(`${method.toUpperCase()} ${pathKey}`);
    }
  }

  const missing = REQUIRED_GUARD_OPENAPI_PATHS.filter((p) => !registered.has(p));

  if (missing.length > 0) {
    console.error("Required guard OpenAPI paths missing:");
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }

  console.log(
    `verify:openapi-guard OK (${REQUIRED_GUARD_OPENAPI_PATHS.length} required paths)`,
  );
}

main();
