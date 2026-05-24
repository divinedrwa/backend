-- MonthlyExpenseSummary: Float → Decimal(12,2)
ALTER TABLE "MonthlyExpenseSummary" ALTER COLUMN "totalExpenses" TYPE DECIMAL(12,2) USING "totalExpenses"::DECIMAL(12,2);
ALTER TABLE "MonthlyExpenseSummary" ALTER COLUMN "totalGST" TYPE DECIMAL(12,2) USING "totalGST"::DECIMAL(12,2);
ALTER TABLE "MonthlyExpenseSummary" ALTER COLUMN "totalTDS" TYPE DECIMAL(12,2) USING "totalTDS"::DECIMAL(12,2);
ALTER TABLE "MonthlyExpenseSummary" ALTER COLUMN "netAmount" TYPE DECIMAL(12,2) USING "netAmount"::DECIMAL(12,2);

-- ExpenseBudget: Float → Decimal(12,2)
ALTER TABLE "ExpenseBudget" ALTER COLUMN "budgetAmount" TYPE DECIMAL(12,2) USING "budgetAmount"::DECIMAL(12,2);
ALTER TABLE "ExpenseBudget" ALTER COLUMN "spentAmount" TYPE DECIMAL(12,2) USING "spentAmount"::DECIMAL(12,2);
ALTER TABLE "ExpenseBudget" ALTER COLUMN "remainingAmount" TYPE DECIMAL(12,2) USING "remainingAmount"::DECIMAL(12,2);

-- AdditionalFund: Float → Decimal(12,2)
ALTER TABLE "AdditionalFund" ALTER COLUMN "amount" TYPE DECIMAL(12,2) USING "amount"::DECIMAL(12,2);

-- BillingLateFeeWaiver: onDelete Cascade → Restrict on user FK
ALTER TABLE "billing_late_fee_waivers" DROP CONSTRAINT "billing_late_fee_waivers_userId_fkey";
ALTER TABLE "billing_late_fee_waivers" ADD CONSTRAINT "billing_late_fee_waivers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
