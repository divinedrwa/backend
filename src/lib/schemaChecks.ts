import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

let themeColorsColumnKnown: boolean | null = null;
let themeColorsColumnCheckedAt = 0;
const CACHE_TTL_MS = 60_000;

/** Read-only: does `Society.themeColors` exist on the DB this API is connected to? */
export async function societyThemeColorsColumnExists(): Promise<boolean> {
  const now = Date.now();
  if (themeColorsColumnKnown !== null && now - themeColorsColumnCheckedAt < CACHE_TTL_MS) {
    return themeColorsColumnKnown;
  }

  const rows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Society'
        AND column_name = 'themeColors'
    ) AS "exists"
  `;
  themeColorsColumnKnown = Boolean(rows[0]?.exists);
  themeColorsColumnCheckedAt = now;
  return themeColorsColumnKnown;
}

/** True for any "column does not exist" error (Prisma P2022) — used to tolerate
 *  optional newer columns (themeColors, splashUrl) when a migration lags a deploy. */
export function isMissingColumnError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2022"
  );
}

export function isMissingThemeColorsColumn(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2022") return false;
  const column =
    error.meta && typeof error.meta === "object" && "column" in error.meta
      ? String((error.meta as { column?: string }).column ?? "")
      : "";
  return column.includes("themeColors");
}

/** Idempotent DDL — safe to run when migrate history says applied but column is missing. */
export async function repairSocietyThemeColorsColumn(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "Society" ADD COLUMN IF NOT EXISTS "themeColors" JSONB',
  );
  themeColorsColumnKnown = true;
  themeColorsColumnCheckedAt = Date.now();
}
