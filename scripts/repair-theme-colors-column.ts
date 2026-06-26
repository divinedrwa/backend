/**
 * Idempotent repair for Society.themeColors when _prisma_migrations shows applied
 * but the column is missing (baselined / partial deploy drift).
 *
 *   cd backend && npm run repair:theme-colors-column
 */
import path from "path";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });
import {
  repairSocietyThemeColorsColumn,
  societyThemeColorsColumnExists,
} from "../src/lib/schemaChecks";
import { prisma } from "../src/lib/prisma";

async function main() {
  const masked = (process.env.DATABASE_URL ?? "").replace(/:[^:@]+@/, ":****@");
  console.log(`DATABASE_URL: ${masked}\n`);

  const before = await societyThemeColorsColumnExists();
  console.log(`Before: Society.themeColors ${before ? "EXISTS" : "MISSING"}`);

  if (!before) {
    await repairSocietyThemeColorsColumn();
    console.log("Ran: ALTER TABLE \"Society\" ADD COLUMN IF NOT EXISTS \"themeColors\" JSONB");
  } else {
    console.log("No repair needed.");
  }

  const after = await societyThemeColorsColumnExists();
  console.log(`After:  Society.themeColors ${after ? "EXISTS" : "MISSING"}`);

  if (!after) {
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
