-- AlterTable
ALTER TABLE "MaintenancePayment" ADD COLUMN "financialYearId" TEXT;

-- CreateIndex
CREATE INDEX "MaintenancePayment_financialYearId_idx" ON "MaintenancePayment"("financialYearId");

-- AddForeignKey
ALTER TABLE "MaintenancePayment" ADD CONSTRAINT "MaintenancePayment_financialYearId_fkey" FOREIGN KEY ("financialYearId") REFERENCES "FinancialYear"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: set financialYearId on unlinked adjustments by matching month/year to cycles
UPDATE "MaintenancePayment" mp
SET "financialYearId" = sub."financialYearId"
FROM (
  SELECT DISTINCT mcc."financialYearId", mcc."periodMonth", mcc."periodYear", mcc."societyId"
  FROM "MaintenanceCollectionCycle" mcc
) sub
WHERE mp."maintenanceCollectionCycleId" IS NULL
  AND mp."financialYearId" IS NULL
  AND mp."month" = sub."periodMonth"
  AND mp."year" = sub."periodYear"
  AND mp."societyId" = sub."societyId";

-- Backfill: set financialYearId on linked payments from their cycle
UPDATE "MaintenancePayment" mp
SET "financialYearId" = mcc."financialYearId"
FROM "MaintenanceCollectionCycle" mcc
WHERE mp."maintenanceCollectionCycleId" = mcc."id"
  AND mp."financialYearId" IS NULL;
