-- Visits auto-closed because the guard never marked exit.
ALTER TABLE "Visitor" ADD COLUMN IF NOT EXISTS "exitNotMarked" BOOLEAN NOT NULL DEFAULT false;
