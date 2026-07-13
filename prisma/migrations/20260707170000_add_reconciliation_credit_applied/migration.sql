-- A6: explicit credit line on reconciliation alerts
ALTER TABLE "ReconciliationAlert" ADD COLUMN IF NOT EXISTS "creditApplied" DECIMAL(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE "ReconciliationAlert" ADD COLUMN IF NOT EXISTS "unexplainedDifference" DECIMAL(12, 2);
