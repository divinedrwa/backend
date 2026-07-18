/**
 * Emit OpenAPI JSON for frontend typed client generation.
 *
 * Usage: npm run openapi:emit
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateOpenApiDocument } from "../src/lib/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(
  __dirname,
  "../../frontend/src/lib/api/generated/openapi.json",
);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`);
console.log(`Wrote ${OUT}`);
