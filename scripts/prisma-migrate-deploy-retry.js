#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const MAX_ATTEMPTS = Number(process.env.PRISMA_MIGRATE_MAX_ATTEMPTS ?? "6");
const BASE_DELAY_MS = Number(process.env.PRISMA_MIGRATE_RETRY_BASE_MS ?? "5000");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(output) {
  const text = (output || "").toLowerCase();
  return (
    text.includes("error: p1002") ||
    text.includes("timed out trying to acquire a postgres advisory lock") ||
    text.includes("pg_advisory_lock")
  );
}

async function run() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-console
    console.log(`[migrate-retry] attempt ${attempt}/${MAX_ATTEMPTS}`);
    const child = spawnSync("npx", ["prisma", "migrate", "deploy"], {
      stdio: "pipe",
      encoding: "utf8",
      env: process.env,
    });

    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);

    if (child.status === 0) {
      // eslint-disable-next-line no-console
      console.log("[migrate-retry] migrations applied successfully.");
      process.exit(0);
    }

    const combined = `${child.stdout || ""}\n${child.stderr || ""}`;
    if (!isRetryable(combined) || attempt === MAX_ATTEMPTS) {
      // eslint-disable-next-line no-console
      console.error("[migrate-retry] non-retryable migration error or max attempts reached.");
      process.exit(child.status || 1);
    }

    const delay = BASE_DELAY_MS * attempt;
    // eslint-disable-next-line no-console
    console.warn(`[migrate-retry] advisory lock timeout detected; retrying in ${delay}ms...`);
    await sleep(delay);
  }
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[migrate-retry] unexpected failure:", error);
  process.exit(1);
});
