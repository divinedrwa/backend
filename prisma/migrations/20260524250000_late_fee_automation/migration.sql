-- AlterTable: Society late fee config
ALTER TABLE "Society" ADD COLUMN "lateFeePercentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "lateFeeFixedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "maintenanceGracePeriodDays" INTEGER NOT NULL DEFAULT 15;

-- AlterTable: VillaMaintenanceSnapshot late fee tracking
ALTER TABLE "VillaMaintenanceSnapshot" ADD COLUMN "lateFeeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "lateFeeAppliedAt" TIMESTAMP(3);
