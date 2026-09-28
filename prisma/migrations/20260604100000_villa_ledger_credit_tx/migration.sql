-- Reconstructed on 2026-09-28 from the production schema; the original file was lost.
-- The original also backfilled villa_ledger_entries from existing bills/payments; that data step is not reproduced.

-- CreateEnum
CREATE TYPE "CreditTransactionType" AS ENUM ('OVERPAYMENT', 'MANUAL_ADD', 'MANUAL_DEDUCT', 'AUTO_APPLY', 'REFUND');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('BILL', 'PAYMENT', 'CREDIT_APPLY', 'CREDIT_ADD', 'CREDIT_DEDUCT', 'LATE_FEE', 'ADJUSTMENT', 'WAIVER', 'REFUND', 'PROJECT_PAYMENT', 'PROJECT_EXPENSE');

-- AlterTable
ALTER TABLE "Villa" ADD COLUMN "creditBalance" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "villa_ledger_entries" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "debitAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "creditAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "runningBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversalOfId" TEXT,

    CONSTRAINT "villa_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_transactions" (
    "id" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "type" "CreditTransactionType" NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "description" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "villa_ledger_entries_referenceType_referenceId_idx" ON "villa_ledger_entries"("referenceType", "referenceId");
CREATE INDEX "villa_ledger_entries_reversalOfId_idx" ON "villa_ledger_entries"("reversalOfId");
CREATE INDEX "villa_ledger_entries_societyId_entryDate_idx" ON "villa_ledger_entries"("societyId", "entryDate");
CREATE INDEX "villa_ledger_entries_villaId_entryDate_idx" ON "villa_ledger_entries"("villaId", "entryDate");
CREATE INDEX "credit_transactions_expiresAt_idx" ON "credit_transactions"("expiresAt");
CREATE INDEX "credit_transactions_societyId_createdAt_idx" ON "credit_transactions"("societyId", "createdAt");
CREATE INDEX "credit_transactions_villaId_createdAt_idx" ON "credit_transactions"("villaId", "createdAt");

-- AddForeignKey
ALTER TABLE "villa_ledger_entries" ADD CONSTRAINT "villa_ledger_entries_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "villa_ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "villa_ledger_entries" ADD CONSTRAINT "villa_ledger_entries_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "villa_ledger_entries" ADD CONSTRAINT "villa_ledger_entries_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
