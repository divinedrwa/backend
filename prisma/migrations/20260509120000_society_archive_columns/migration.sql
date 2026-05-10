-- Society soft-delete columns. Backfilled as NULL for existing rows
-- (i.e. all current societies are not-archived). Apply with
-- `npx prisma migrate deploy` (or the wrapping retry script for Neon).
ALTER TABLE "Society"
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archivedBy" TEXT;

CREATE INDEX "Society_archivedAt_idx" ON "Society"("archivedAt");
