-- Expense module (categories, expenses, monthly summaries, budgets) — was in schema but not migrated.

-- CreateEnum
CREATE TYPE "ExpenseType" AS ENUM (
  'ELECTRICITY',
  'WATER',
  'GARBAGE_COLLECTION',
  'SECURITY_SALARY',
  'HOUSEKEEPING_SALARY',
  'MAINTENANCE_STAFF',
  'GARDENING',
  'PEST_CONTROL',
  'LIFT_MAINTENANCE',
  'GENERATOR_MAINTENANCE',
  'PUMP_MAINTENANCE',
  'COMMON_AREA_REPAIR',
  'LEGAL_FEES',
  'INSURANCE',
  'TAXES',
  'BANK_CHARGES',
  'SOFTWARE_SUBSCRIPTION',
  'MISCELLANEOUS',
  'OTHER'
);

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "type" "ExpenseType" NOT NULL DEFAULT 'OTHER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "defaultAmount" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "paymentMode" "PaymentMode" NOT NULL,
    "paymentRef" TEXT,
    "paidTo" TEXT NOT NULL,
    "paidToContact" TEXT,
    "receiptUrl" TEXT,
    "receiptNumber" TEXT,
    "invoiceNumber" TEXT,
    "month" INTEGER,
    "year" INTEGER,
    "gstAmount" DOUBLE PRECISION DEFAULT 0,
    "gstPercentage" DOUBLE PRECISION DEFAULT 0,
    "tdsAmount" DOUBLE PRECISION DEFAULT 0,
    "tdsPercentage" DOUBLE PRECISION DEFAULT 0,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'APPROVED',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseAttachment" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedBy" TEXT,

    CONSTRAINT "ExpenseAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyExpenseSummary" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "totalExpenses" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalGST" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTDS" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expenseCount" INTEGER NOT NULL DEFAULT 0,
    "categoryBreakdown" JSONB,
    "lastCalculated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthlyExpenseSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseBudget" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "categoryId" TEXT,
    "month" INTEGER,
    "year" INTEGER NOT NULL,
    "budgetAmount" DOUBLE PRECISION NOT NULL,
    "spentAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remainingAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "alertThreshold" DOUBLE PRECISION DEFAULT 80,
    "alertSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "ExpenseBudget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_societyId_name_key" ON "ExpenseCategory"("societyId", "name");

-- CreateIndex
CREATE INDEX "ExpenseCategory_societyId_idx" ON "ExpenseCategory"("societyId");

-- CreateIndex
CREATE INDEX "ExpenseCategory_type_idx" ON "ExpenseCategory"("type");

-- CreateIndex
CREATE INDEX "Expense_societyId_idx" ON "Expense"("societyId");

-- CreateIndex
CREATE INDEX "Expense_categoryId_idx" ON "Expense"("categoryId");

-- CreateIndex
CREATE INDEX "Expense_paymentDate_idx" ON "Expense"("paymentDate");

-- CreateIndex
CREATE INDEX "Expense_month_year_idx" ON "Expense"("month", "year");

-- CreateIndex
CREATE INDEX "Expense_status_idx" ON "Expense"("status");

-- CreateIndex
CREATE INDEX "ExpenseAttachment_expenseId_idx" ON "ExpenseAttachment"("expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyExpenseSummary_societyId_month_year_key" ON "MonthlyExpenseSummary"("societyId", "month", "year");

-- CreateIndex
CREATE INDEX "MonthlyExpenseSummary_societyId_idx" ON "MonthlyExpenseSummary"("societyId");

-- CreateIndex
CREATE INDEX "MonthlyExpenseSummary_year_month_idx" ON "MonthlyExpenseSummary"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseBudget_societyId_categoryId_month_year_key" ON "ExpenseBudget"("societyId", "categoryId", "month", "year");

-- CreateIndex
CREATE INDEX "ExpenseBudget_societyId_idx" ON "ExpenseBudget"("societyId");

-- AddForeignKey
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseAttachment" ADD CONSTRAINT "ExpenseAttachment_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyExpenseSummary" ADD CONSTRAINT "MonthlyExpenseSummary_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseBudget" ADD CONSTRAINT "ExpenseBudget_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseBudget" ADD CONSTRAINT "ExpenseBudget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
