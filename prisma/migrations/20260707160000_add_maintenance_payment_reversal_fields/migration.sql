-- L1: additive reversal metadata on MaintenancePayment (offset rows + audit trail)
ALTER TABLE "MaintenancePayment" ADD COLUMN IF NOT EXISTS "reversedAt" TIMESTAMP(3);
ALTER TABLE "MaintenancePayment" ADD COLUMN IF NOT EXISTS "reversedByUserId" TEXT;
ALTER TABLE "MaintenancePayment" ADD COLUMN IF NOT EXISTS "reversalReason" TEXT;
ALTER TABLE "MaintenancePayment" ADD COLUMN IF NOT EXISTS "reversalOfPaymentId" TEXT;

CREATE INDEX IF NOT EXISTS "MaintenancePayment_reversalOfPaymentId_idx"
  ON "MaintenancePayment"("reversalOfPaymentId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MaintenancePayment_reversalOfPaymentId_fkey'
  ) THEN
    ALTER TABLE "MaintenancePayment"
      ADD CONSTRAINT "MaintenancePayment_reversalOfPaymentId_fkey"
      FOREIGN KEY ("reversalOfPaymentId") REFERENCES "MaintenancePayment"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
