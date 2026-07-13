-- Phase 0 (J1/A3): additive sandbox flag — safe for production deploy (default false).
ALTER TABLE "Society" ADD COLUMN IF NOT EXISTS "isSandbox" BOOLEAN NOT NULL DEFAULT false;
