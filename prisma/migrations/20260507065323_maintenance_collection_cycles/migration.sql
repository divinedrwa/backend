-- CreateEnum
CREATE TYPE "FinancialYearStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "MaintenanceCollectionCycleStatus" AS ENUM ('OPEN', 'CLOSED', 'LOCKED');

-- CreateEnum
CREATE TYPE "MaintenanceCycleRuleType" AS ENUM ('FIXED_PER_FLAT', 'PER_SQFT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "VillaMaintenanceSnapshotStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED');

-- AlterTable
ALTER TABLE "MaintenancePayment" ADD COLUMN     "maintenanceCollectionCycleId" TEXT,
ADD COLUMN     "villaMaintenanceSnapshotId" TEXT;

-- CreateTable
CREATE TABLE "FinancialYear" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "FinancialYearStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceCollectionCycle" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "financialYearId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "MaintenanceCollectionCycleStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceCollectionCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceCycleRule" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "ruleType" "MaintenanceCycleRuleType" NOT NULL,
    "baseAmount" DECIMAL(12,2),
    "perSqftRate" DECIMAL(12,4),
    "customAmounts" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceCycleRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VillaMaintenanceSnapshot" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "expectedAmount" DECIMAL(12,2) NOT NULL,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "VillaMaintenanceSnapshotStatus" NOT NULL DEFAULT 'PENDING',
    "breakdown" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VillaMaintenanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinancialYear_societyId_idx" ON "FinancialYear"("societyId");

-- CreateIndex
CREATE INDEX "FinancialYear_societyId_status_idx" ON "FinancialYear"("societyId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceCollectionCycle_societyId_idx" ON "MaintenanceCollectionCycle"("societyId");

-- CreateIndex
CREATE INDEX "MaintenanceCollectionCycle_societyId_periodYear_periodMonth_idx" ON "MaintenanceCollectionCycle"("societyId", "periodYear", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceCollectionCycle_financialYearId_periodKey_key" ON "MaintenanceCollectionCycle"("financialYearId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceCycleRule_cycleId_key" ON "MaintenanceCycleRule"("cycleId");

-- CreateIndex
CREATE INDEX "VillaMaintenanceSnapshot_villaId_idx" ON "VillaMaintenanceSnapshot"("villaId");

-- CreateIndex
CREATE UNIQUE INDEX "VillaMaintenanceSnapshot_cycleId_villaId_key" ON "VillaMaintenanceSnapshot"("cycleId", "villaId");

-- CreateIndex
CREATE INDEX "MaintenancePayment_maintenanceCollectionCycleId_idx" ON "MaintenancePayment"("maintenanceCollectionCycleId");

-- CreateIndex
CREATE INDEX "MaintenancePayment_villaMaintenanceSnapshotId_idx" ON "MaintenancePayment"("villaMaintenanceSnapshotId");

-- AddForeignKey
ALTER TABLE "MaintenancePayment" ADD CONSTRAINT "MaintenancePayment_maintenanceCollectionCycleId_fkey" FOREIGN KEY ("maintenanceCollectionCycleId") REFERENCES "MaintenanceCollectionCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePayment" ADD CONSTRAINT "MaintenancePayment_villaMaintenanceSnapshotId_fkey" FOREIGN KEY ("villaMaintenanceSnapshotId") REFERENCES "VillaMaintenanceSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialYear" ADD CONSTRAINT "FinancialYear_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceCollectionCycle" ADD CONSTRAINT "MaintenanceCollectionCycle_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceCollectionCycle" ADD CONSTRAINT "MaintenanceCollectionCycle_financialYearId_fkey" FOREIGN KEY ("financialYearId") REFERENCES "FinancialYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceCycleRule" ADD CONSTRAINT "MaintenanceCycleRule_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "MaintenanceCollectionCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VillaMaintenanceSnapshot" ADD CONSTRAINT "VillaMaintenanceSnapshot_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "MaintenanceCollectionCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VillaMaintenanceSnapshot" ADD CONSTRAINT "VillaMaintenanceSnapshot_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;
