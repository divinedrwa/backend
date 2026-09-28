-- Reconstructed on 2026-09-28 from the production schema; the original file was lost.

-- CreateEnum
CREATE TYPE "AutoBillingTemplateRuleType" AS ENUM ('FIXED_PER_FLAT', 'PER_SQFT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "LateFeeCalculationType" AS ENUM ('FLAT', 'PERCENTAGE', 'COMPOUND_MONTHLY');

-- CreateEnum
CREATE TYPE "ReminderTriggerType" AS ENUM ('DAYS_BEFORE_DUE', 'DAYS_AFTER_DUE', 'FIXED_DAY_OF_MONTH');

-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('PUSH', 'SMS', 'EMAIL', 'WHATSAPP');

-- AlterTable
ALTER TABLE "Society" ADD COLUMN "autoBillingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "autoBillingDayOfMonth" INTEGER,
ADD COLUMN "autoBillingTemplateRuleType" "AutoBillingTemplateRuleType",
ADD COLUMN "autoBillingTemplateBaseAmount" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "MaintenancePayment" ADD COLUMN "paidByUserId" TEXT,
ADD COLUMN "approvedByUserId" TEXT;

-- CreateTable
CREATE TABLE "late_fee_rules" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "calculationType" "LateFeeCalculationType" NOT NULL,
    "amount" DECIMAL(12,2),
    "rate" DOUBLE PRECISION,
    "graceDays" INTEGER NOT NULL DEFAULT 15,
    "maxPenalty" DECIMAL(12,2),
    "applyToArrears" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "late_fee_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_rules" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "triggerType" "ReminderTriggerType" NOT NULL,
    "triggerValue" INTEGER NOT NULL,
    "channel" "ReminderChannel" NOT NULL DEFAULT 'PUSH',
    "messageTemplate" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminder_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceLineItemTemplate" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "componentName" TEXT NOT NULL,
    "defaultAmount" DECIMAL(12,2) NOT NULL,
    "isWaivable" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceLineItemTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceLineItem" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "componentName" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "isWaivable" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceLateFeeWaiver" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "waivedByUserId" TEXT NOT NULL,
    "reason" TEXT,
    "originalLateFee" DECIMAL(12,2) NOT NULL,
    "waivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceLateFeeWaiver_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "late_fee_rules_societyId_idx" ON "late_fee_rules"("societyId");
CREATE INDEX "reminder_rules_societyId_idx" ON "reminder_rules"("societyId");
CREATE UNIQUE INDEX "MaintenanceLineItemTemplate_societyId_componentName_key" ON "MaintenanceLineItemTemplate"("societyId", "componentName");
CREATE INDEX "MaintenanceLineItemTemplate_societyId_idx" ON "MaintenanceLineItemTemplate"("societyId");
CREATE INDEX "MaintenanceLineItem_snapshotId_idx" ON "MaintenanceLineItem"("snapshotId");
CREATE UNIQUE INDEX "MaintenanceLateFeeWaiver_snapshotId_key" ON "MaintenanceLateFeeWaiver"("snapshotId");
CREATE INDEX "MaintenancePayment_paidByUserId_idx" ON "MaintenancePayment"("paidByUserId");

-- AddForeignKey
ALTER TABLE "late_fee_rules" ADD CONSTRAINT "late_fee_rules_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reminder_rules" ADD CONSTRAINT "reminder_rules_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaintenanceLineItemTemplate" ADD CONSTRAINT "MaintenanceLineItemTemplate_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaintenanceLineItem" ADD CONSTRAINT "MaintenanceLineItem_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "VillaMaintenanceSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaintenanceLateFeeWaiver" ADD CONSTRAINT "MaintenanceLateFeeWaiver_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "VillaMaintenanceSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaintenanceLateFeeWaiver" ADD CONSTRAINT "MaintenanceLateFeeWaiver_waivedByUserId_fkey" FOREIGN KEY ("waivedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaintenancePayment" ADD CONSTRAINT "MaintenancePayment_paidByUserId_fkey" FOREIGN KEY ("paidByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MaintenancePayment" ADD CONSTRAINT "MaintenancePayment_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
