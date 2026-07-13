-- A8/A9: Society maintenance billing mode (fixed per villa vs per sq ft)
CREATE TYPE "MaintenanceBillingMode" AS ENUM ('FIXED', 'SQFT');

ALTER TABLE "Society"
  ADD COLUMN "maintenanceBillingMode" "MaintenanceBillingMode" NOT NULL DEFAULT 'FIXED',
  ADD COLUMN "maintenanceFixedAmount" DECIMAL(12,2),
  ADD COLUMN "maintenanceSqftRate" DECIMAL(12,4);
