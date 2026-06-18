-- Add letterheadUrl to Society (nullable, additive — safe). Idempotent.
ALTER TABLE "Society" ADD COLUMN IF NOT EXISTS "letterheadUrl" TEXT;
