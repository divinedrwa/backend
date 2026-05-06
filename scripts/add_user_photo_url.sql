-- Run if `photoUrl` column is missing (e.g. migrate history out of sync):
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "photoUrl" TEXT;
