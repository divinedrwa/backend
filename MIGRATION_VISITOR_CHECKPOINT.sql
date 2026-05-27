-- Migration: Add VisitorCheckpoint model and visitor audit fields
-- Run this with: npm run prisma:migrate -- --name add_visitor_checkpoint_and_audit_fields
-- Or manually apply in production with: npm run prisma:migrate:deploy

-- Step 1: Create VisitorCheckpointType enum
CREATE TYPE "VisitorCheckpointType" AS ENUM (
  'ENTRY_REQUESTED',
  'APPROVAL_PENDING',
  'APPROVED',
  'REJECTED',
  'ADMITTED',
  'EXITED',
  'EMERGENCY_OVERRIDE'
);

-- Step 2: Add CANCELLED to VisitorStatus enum (if not already present)
-- Note: Postgres ALTER TYPE ADD VALUE cannot be rolled back in a transaction
-- Check if CANCELLED exists first
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'CANCELLED' AND enumtypid = 'VisitorStatus'::regtype) THEN
        ALTER TYPE "VisitorStatus" ADD VALUE 'CANCELLED';
    END IF;
END$$;

-- Step 3: Add new fields to Visitor table
ALTER TABLE "Visitor" 
  ADD COLUMN IF NOT EXISTS "photoUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "checkedInByGuardId" TEXT,
  ADD COLUMN IF NOT EXISTS "checkedOutByGuardId" TEXT;

-- Step 4: Create indexes on new Visitor fields
CREATE INDEX IF NOT EXISTS "Visitor_checkedInByGuardId_idx" ON "Visitor"("checkedInByGuardId");
CREATE INDEX IF NOT EXISTS "Visitor_checkedOutByGuardId_idx" ON "Visitor"("checkedOutByGuardId");

-- Step 5: Add foreign key constraints to new Visitor fields
ALTER TABLE "Visitor"
  ADD CONSTRAINT "Visitor_checkedInByGuardId_fkey" 
  FOREIGN KEY ("checkedInByGuardId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Visitor"
  ADD CONSTRAINT "Visitor_checkedOutByGuardId_fkey" 
  FOREIGN KEY ("checkedOutByGuardId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Step 6: Create VisitorCheckpoint table
CREATE TABLE IF NOT EXISTS "VisitorCheckpoint" (
  "id" TEXT NOT NULL,
  "visitorId" TEXT NOT NULL,
  "checkpointType" "VisitorCheckpointType" NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VisitorCheckpoint_pkey" PRIMARY KEY ("id")
);

-- Step 7: Create indexes on VisitorCheckpoint
CREATE INDEX IF NOT EXISTS "VisitorCheckpoint_visitorId_timestamp_idx" ON "VisitorCheckpoint"("visitorId", "timestamp");
CREATE INDEX IF NOT EXISTS "VisitorCheckpoint_actorUserId_idx" ON "VisitorCheckpoint"("actorUserId");
CREATE INDEX IF NOT EXISTS "VisitorCheckpoint_checkpointType_idx" ON "VisitorCheckpoint"("checkpointType");

-- Step 8: Add foreign key constraints to VisitorCheckpoint
ALTER TABLE "VisitorCheckpoint"
  ADD CONSTRAINT "VisitorCheckpoint_visitorId_fkey" 
  FOREIGN KEY ("visitorId") REFERENCES "Visitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VisitorCheckpoint"
  ADD CONSTRAINT "VisitorCheckpoint_actorUserId_fkey" 
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Step 9: Verify the migration
-- SELECT 'Migration completed successfully' as status;
