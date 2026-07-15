#!/usr/bin/env npx tsx
/**
 * Run Prisma CLI with .env.local overriding .env (local Postgres only).
 * Usage: tsx scripts/prisma-with-local-env.ts migrate deploy
 */
import path from "path";
import { spawnSync } from "child_process";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: tsx scripts/prisma-with-local-env.ts <prisma-args...>");
  console.error("Example: tsx scripts/prisma-with-local-env.ts migrate deploy");
  process.exit(1);
}

const result = spawnSync("npx", ["prisma", ...args], {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd(),
});

process.exit(result.status ?? 1);
