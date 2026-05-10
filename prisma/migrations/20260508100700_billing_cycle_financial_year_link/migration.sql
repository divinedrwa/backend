-- AlterTable
ALTER TABLE "BillingCycle" ADD COLUMN "financialYearId" TEXT;

-- CreateIndex
CREATE INDEX "BillingCycle_financialYearId_idx" ON "BillingCycle"("financialYearId");

-- AddForeignKey
ALTER TABLE "BillingCycle"
ADD CONSTRAINT "BillingCycle_financialYearId_fkey"
FOREIGN KEY ("financialYearId") REFERENCES "FinancialYear"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
