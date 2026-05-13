-- AlterTable
ALTER TABLE "MaintenancePayment" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MaintenancePayment_idempotencyKey_key" ON "MaintenancePayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MaintenancePayment_idempotencyKey_idx" ON "MaintenancePayment"("idempotencyKey");

-- Add CHECK constraint to prevent negative amounts
ALTER TABLE "MaintenancePayment" ADD CONSTRAINT "check_amount_positive" CHECK ("amount" > 0);

-- Add CHECK constraint to prevent negative paid amounts on snapshots
ALTER TABLE "VillaMaintenanceSnapshot" ADD CONSTRAINT "check_paid_amount_non_negative" CHECK ("paidAmount" >= 0);
