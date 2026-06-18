-- Add signatureUrl and stampUrl to Society (nullable, additive — safe). Idempotent.
ALTER TABLE "Society" ADD COLUMN IF NOT EXISTS "signatureUrl" TEXT;
ALTER TABLE "Society" ADD COLUMN IF NOT EXISTS "stampUrl" TEXT;
