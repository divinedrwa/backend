-- Migration: Add SOS audit trail and persistent escalation
-- Run this with: npm run prisma:migrate -- --name add_sos_checkpoint_and_escalation
-- Or manually apply in production with: npm run prisma:migrate:deploy

-- Step 1: Create SOSCheckpointType enum
CREATE TYPE "SOSCheckpointType" AS ENUM (
  'CREATED',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'RESOLVED',
  'CANCELLED',
  'ESCALATED'
);

-- Step 2: Create SOSEscalationStatus enum
CREATE TYPE "SOSEscalationStatus" AS ENUM (
  'PENDING',
  'EXECUTED',
  'SKIPPED',
  'FAILED'
);

-- Step 3: Create SOSCheckpoint table
CREATE TABLE IF NOT EXISTS "SOSCheckpoint" (
  "id" TEXT NOT NULL,
  "alertId" TEXT NOT NULL,
  "checkpointType" "SOSCheckpointType" NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL,
  "actorUserId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SOSCheckpoint_pkey" PRIMARY KEY ("id")
);

-- Step 4: Create indexes on SOSCheckpoint
CREATE INDEX IF NOT EXISTS "SOSCheckpoint_alertId_timestamp_idx" ON "SOSCheckpoint"("alertId", "timestamp");
CREATE INDEX IF NOT EXISTS "SOSCheckpoint_actorUserId_idx" ON "SOSCheckpoint"("actorUserId");
CREATE INDEX IF NOT EXISTS "SOSCheckpoint_checkpointType_idx" ON "SOSCheckpoint"("checkpointType");

-- Step 5: Add foreign key constraints to SOSCheckpoint
ALTER TABLE "SOSCheckpoint"
  ADD CONSTRAINT "SOSCheckpoint_alertId_fkey" 
  FOREIGN KEY ("alertId") REFERENCES "SOSAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SOSCheckpoint"
  ADD CONSTRAINT "SOSCheckpoint_actorUserId_fkey" 
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Step 6: Create SOSEscalation table (replaces in-memory timers)
CREATE TABLE IF NOT EXISTS "SOSEscalation" (
  "id" TEXT NOT NULL,
  "alertId" TEXT NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "processedAt" TIMESTAMP(3),
  "status" "SOSEscalationStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SOSEscalation_pkey" PRIMARY KEY ("id")
);

-- Step 7: Create indexes on SOSEscalation
CREATE INDEX IF NOT EXISTS "SOSEscalation_alertId_idx" ON "SOSEscalation"("alertId");
CREATE INDEX IF NOT EXISTS "SOSEscalation_scheduledAt_status_idx" ON "SOSEscalation"("scheduledAt", "status");
CREATE INDEX IF NOT EXISTS "SOSEscalation_status_idx" ON "SOSEscalation"("status");

-- Step 8: Add foreign key constraint to SOSEscalation
ALTER TABLE "SOSEscalation"
  ADD CONSTRAINT "SOSEscalation_alertId_fkey" 
  FOREIGN KEY ("alertId") REFERENCES "SOSAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 9: Backfill checkpoints for existing alerts (optional)
-- This creates CREATED checkpoints for all existing SOS alerts
INSERT INTO "SOSCheckpoint" (
  "id",
  "alertId",
  "checkpointType",
  "timestamp",
  "actorUserId",
  "createdAt"
)
SELECT
  gen_random_uuid()::text,
  id,
  'CREATED'::"SOSCheckpointType",
  "createdAt",
  "triggeredBy",
  "createdAt"
FROM "SOSAlert"
ON CONFLICT DO NOTHING;

-- Step 10: Backfill additional checkpoints based on existing state
-- ACKNOWLEDGED checkpoints
INSERT INTO "SOSCheckpoint" (
  "id",
  "alertId",
  "checkpointType",
  "timestamp",
  "actorUserId",
  "createdAt"
)
SELECT
  gen_random_uuid()::text,
  id,
  'ACKNOWLEDGED'::"SOSCheckpointType",
  "acknowledgedAt",
  "acknowledgedBy",
  "acknowledgedAt"
FROM "SOSAlert"
WHERE "acknowledgedAt" IS NOT NULL
ON CONFLICT DO NOTHING;

-- IN_PROGRESS checkpoints
INSERT INTO "SOSCheckpoint" (
  "id",
  "alertId",
  "checkpointType",
  "timestamp",
  "actorUserId",
  "createdAt"
)
SELECT
  gen_random_uuid()::text,
  id,
  'IN_PROGRESS'::"SOSCheckpointType",
  "inProgressAt",
  "assignedGuardId",
  "inProgressAt"
FROM "SOSAlert"
WHERE "inProgressAt" IS NOT NULL
ON CONFLICT DO NOTHING;

-- RESOLVED checkpoints
INSERT INTO "SOSCheckpoint" (
  "id",
  "alertId",
  "checkpointType",
  "timestamp",
  "actorUserId",
  "createdAt"
)
SELECT
  gen_random_uuid()::text,
  id,
  'RESOLVED'::"SOSCheckpointType",
  "resolvedAt",
  "resolvedBy",
  "resolvedAt"
FROM "SOSAlert"
WHERE "resolvedAt" IS NOT NULL AND "status" = 'RESOLVED'
ON CONFLICT DO NOTHING;

-- CANCELLED checkpoints
INSERT INTO "SOSCheckpoint" (
  "id",
  "alertId",
  "checkpointType",
  "timestamp",
  "actorUserId",
  "createdAt"
)
SELECT
  gen_random_uuid()::text,
  id,
  'CANCELLED'::"SOSCheckpointType",
  "resolvedAt",
  "triggeredBy",
  "resolvedAt"
FROM "SOSAlert"
WHERE "resolvedAt" IS NOT NULL AND "status" = 'CANCELLED'
ON CONFLICT DO NOTHING;

-- ESCALATED checkpoints
INSERT INTO "SOSCheckpoint" (
  "id",
  "alertId",
  "checkpointType",
  "timestamp",
  "actorUserId",
  "createdAt"
)
SELECT
  gen_random_uuid()::text,
  id,
  'ESCALATED'::"SOSCheckpointType",
  "escalationNotifiedAt",
  NULL,
  "escalationNotifiedAt"
FROM "SOSAlert"
WHERE "escalationNotifiedAt" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Step 11: Verify the migration
-- SELECT 'Migration completed successfully' as status;
