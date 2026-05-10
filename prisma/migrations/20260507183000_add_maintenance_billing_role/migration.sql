-- CreateEnum
CREATE TYPE "MaintenanceBillingRole" AS ENUM ('PRIMARY', 'EXCLUDED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "maintenanceBillingRole" "MaintenanceBillingRole" NOT NULL DEFAULT 'PRIMARY';

-- One active PRIMARY payer per villa (household maintenance demand is villa-level for now).
-- Before enforcing, mark secondary active residents on the same villa as EXCLUDED (keep earliest created as PRIMARY).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "villaId"
      ORDER BY "createdAt" ASC, id ASC
    ) AS rn
  FROM "User"
  WHERE "role" = 'RESIDENT'
    AND "isActive" = true
    AND "villaId" IS NOT NULL
)
UPDATE "User" u
SET "maintenanceBillingRole" = 'EXCLUDED'::"MaintenanceBillingRole"
FROM ranked r
WHERE u.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX "User_one_active_primary_maintenance_per_villa"
ON "User" ("villaId")
WHERE "villaId" IS NOT NULL
  AND "role" = 'RESIDENT'
  AND "isActive" = true
  AND "maintenanceBillingRole" = 'PRIMARY'::"MaintenanceBillingRole";
