-- Reconstructed on 2026-09-28 from the production schema; the original file was lost.

-- CreateEnum
CREATE TYPE "FundType" AS ENUM ('MAINTENANCE', 'SINKING', 'CORPUS', 'RESERVE', 'OTHER');

-- CreateEnum
CREATE TYPE "BankStatementMatchStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'IGNORED', 'MANUAL');

-- CreateEnum
CREATE TYPE "ProjectInstallmentStatus" AS ENUM ('UPCOMING', 'DUE', 'OVERDUE', 'PAID', 'PARTIALLY_PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "AdditionalFund" ADD COLUMN "fundType" "FundType" NOT NULL DEFAULT 'OTHER';

-- AlterTable
ALTER TABLE "FinancialYear" ADD COLUMN "openingBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "closingBalance" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN "vendorId" TEXT;

-- AlterTable
ALTER TABLE "project_expenses" ADD COLUMN "vendorId" TEXT;

-- CreateTable
CREATE TABLE "BankStatementUpload" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "unmatchedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementRow" (
    "id" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "transactionDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "isCredit" BOOLEAN NOT NULL,
    "reference" TEXT,
    "balance" DECIMAL(12,2),
    "matchStatus" "BankStatementMatchStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchedPaymentId" TEXT,
    "matchedExpenseId" TEXT,
    "matchConfidence" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_installments" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "installmentNumber" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "ProjectInstallmentStatus" NOT NULL DEFAULT 'UPCOMING',
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "contributionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_installments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdditionalFund_fundType_idx" ON "AdditionalFund"("fundType");
CREATE INDEX "Expense_vendorId_idx" ON "Expense"("vendorId");
CREATE INDEX "project_expenses_vendorId_idx" ON "project_expenses"("vendorId");
CREATE INDEX "BankStatementUpload_societyId_idx" ON "BankStatementUpload"("societyId");
CREATE INDEX "BankStatementRow_matchStatus_idx" ON "BankStatementRow"("matchStatus");
CREATE INDEX "BankStatementRow_uploadId_idx" ON "BankStatementRow"("uploadId");
CREATE UNIQUE INDEX "project_installments_projectId_villaId_installmentNumber_key" ON "project_installments"("projectId", "villaId", "installmentNumber");
CREATE INDEX "project_installments_dueDate_status_idx" ON "project_installments"("dueDate", "status");
CREATE INDEX "project_installments_projectId_idx" ON "project_installments"("projectId");
CREATE INDEX "project_installments_villaId_idx" ON "project_installments"("villaId");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "project_expenses" ADD CONSTRAINT "project_expenses_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BankStatementUpload" ADD CONSTRAINT "BankStatementUpload_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BankStatementUpload" ADD CONSTRAINT "BankStatementUpload_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankStatementRow" ADD CONSTRAINT "BankStatementRow_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "BankStatementUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_installments" ADD CONSTRAINT "project_installments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "special_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_installments" ADD CONSTRAINT "project_installments_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_installments" ADD CONSTRAINT "project_installments_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "project_contributions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
