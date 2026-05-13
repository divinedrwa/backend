-- AlterTable MaintenancePayment - Add idempotency key
ALTER TABLE "MaintenancePayment" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- CreateIndex - Unique constraint on idempotency key
CREATE UNIQUE INDEX IF NOT EXISTS "MaintenancePayment_idempotencyKey_key" ON "MaintenancePayment"("idempotencyKey");

-- CreateIndex - Fast lookup by idempotency key
CREATE INDEX IF NOT EXISTS "MaintenancePayment_idempotencyKey_idx" ON "MaintenancePayment"("idempotencyKey");

-- Add CHECK constraints to prevent negative amounts
ALTER TABLE "MaintenancePayment" DROP CONSTRAINT IF EXISTS "check_amount_positive";
ALTER TABLE "MaintenancePayment" ADD CONSTRAINT "check_amount_positive" CHECK ("amount" > 0);

-- Add CHECK constraint to prevent negative paid amounts on snapshots
ALTER TABLE "VillaMaintenanceSnapshot" DROP CONSTRAINT IF EXISTS "check_paid_amount_non_negative";
ALTER TABLE "VillaMaintenanceSnapshot" ADD CONSTRAINT "check_paid_amount_non_negative" CHECK ("paidAmount" >= 0);

-- CreateTable ReconciliationAlert
CREATE TABLE IF NOT EXISTS "ReconciliationAlert" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "cycleId" TEXT,
    "villaSum" DECIMAL(12,2) NOT NULL,
    "societyCash" DECIMAL(12,2) NOT NULL,
    "difference" DECIMAL(12,2) NOT NULL,
    "severity" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "notes" TEXT,

    CONSTRAINT "ReconciliationAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ReconciliationAlert_societyId_idx" ON "ReconciliationAlert"("societyId");
CREATE INDEX IF NOT EXISTS "ReconciliationAlert_cycleId_idx" ON "ReconciliationAlert"("cycleId");
CREATE INDEX IF NOT EXISTS "ReconciliationAlert_detectedAt_idx" ON "ReconciliationAlert"("detectedAt");
CREATE INDEX IF NOT EXISTS "ReconciliationAlert_resolvedAt_idx" ON "ReconciliationAlert"("resolvedAt");
CREATE INDEX IF NOT EXISTS "ReconciliationAlert_severity_idx" ON "ReconciliationAlert"("severity");

-- AddForeignKey
ALTER TABLE "ReconciliationAlert" ADD CONSTRAINT "ReconciliationAlert_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReconciliationAlert" ADD CONSTRAINT "ReconciliationAlert_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "MaintenanceCollectionCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
