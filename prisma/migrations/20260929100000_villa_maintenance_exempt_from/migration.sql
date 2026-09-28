-- Villas not enrolled in maintenance billing (visitor/guard features only).
ALTER TABLE "Villa" ADD COLUMN IF NOT EXISTS "maintenanceExemptFromPeriod" TEXT;
