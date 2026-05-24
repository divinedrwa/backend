-- Phase 1: Security & Data Integrity Fixes
-- IMPROVEMENTS.md items: #1 (schema), #23, #24, #25, #26

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. Add VisitorStatus enum and migrate Visitor.status from String → enum
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TYPE "VisitorStatus" AS ENUM (
  'PENDING_APPROVAL',
  'APPROVED',
  'CHECKED_IN',
  'CHECKED_OUT',
  'DENIED',
  'CANCELLED'
);

-- Map legacy string values to enum values before altering the column
UPDATE "Visitor"
SET "status" = CASE
  WHEN "status" = 'REJECTED'            THEN 'DENIED'
  WHEN "status" = 'APPROVED_FOR_ENTRY'  THEN 'APPROVED'
  WHEN "status" = 'CHECKED_OUT'         THEN 'CHECKED_OUT'
  WHEN "status" = 'CANCELLED'           THEN 'CANCELLED'
  WHEN "status" = 'PENDING_APPROVAL'    THEN 'PENDING_APPROVAL'
  WHEN "status" = 'APPROVED'            THEN 'APPROVED'
  ELSE 'CHECKED_IN'
END;

ALTER TABLE "Visitor"
  ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "Visitor"
  ALTER COLUMN "status" TYPE "VisitorStatus"
  USING "status"::"VisitorStatus";

ALTER TABLE "Visitor"
  ALTER COLUMN "status" SET DEFAULT 'CHECKED_IN';

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. Expense financial fields: Float → Decimal(12,2) (#23)
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Expense"
  ALTER COLUMN "amount"    TYPE DECIMAL(12,2) USING "amount"::DECIMAL(12,2),
  ALTER COLUMN "gstAmount" TYPE DECIMAL(12,2) USING "gstAmount"::DECIMAL(12,2),
  ALTER COLUMN "tdsAmount" TYPE DECIMAL(12,2) USING "tdsAmount"::DECIMAL(12,2),
  ALTER COLUMN "netAmount" TYPE DECIMAL(12,2) USING "netAmount"::DECIMAL(12,2);

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. SOSAlert.triggeredBy: nullable + SetNull on user delete (#25)
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE "SOSAlert"
  ALTER COLUMN "triggeredBy" DROP NOT NULL;

-- Drop the existing FK (name may vary — adapt if needed)
ALTER TABLE "SOSAlert"
  DROP CONSTRAINT IF EXISTS "SOSAlert_triggeredBy_fkey";

ALTER TABLE "SOSAlert"
  ADD CONSTRAINT "SOSAlert_triggeredBy_fkey"
  FOREIGN KEY ("triggeredBy") REFERENCES "User"("id") ON DELETE SET NULL;

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. user_payments.userId: nullable + SetNull on user delete (#24)
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE "user_payments"
  ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "user_payments"
  DROP CONSTRAINT IF EXISTS "user_payments_userId_fkey";

ALTER TABLE "user_payments"
  ADD CONSTRAINT "user_payments_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL;
