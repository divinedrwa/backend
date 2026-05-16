-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "financialYearId" TEXT;

-- CreateIndex
CREATE INDEX "Expense_financialYearId_idx" ON "Expense"("financialYearId");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_financialYearId_fkey" FOREIGN KEY ("financialYearId") REFERENCES "FinancialYear"("id") ON DELETE SET NULL ON UPDATE CASCADE;
