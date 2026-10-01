-- Why a villa's maintenance billing was stopped (shown to admins; cleared on resume).
ALTER TABLE "Villa" ADD COLUMN IF NOT EXISTS "maintenanceExemptReason" TEXT;
