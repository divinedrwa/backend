-- Visitor audit columns + VisitorCheckpoint; SOS checkpoint + persistent escalation.
-- Fixes production P2022: Visitor.photoUrl (and related centralization schema).

-- CreateEnum (idempotent — safe if manual SQL was partially applied)
DO $$ BEGIN
  CREATE TYPE "VisitorCheckpointType" AS ENUM (
    'ENTRY_REQUESTED',
    'APPROVAL_PENDING',
    'APPROVED',
    'REJECTED',
    'ADMITTED',
    'EXITED',
    'EMERGENCY_OVERRIDE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "SOSCheckpointType" AS ENUM (
    'CREATED',
    'ACKNOWLEDGED',
    'IN_PROGRESS',
    'RESOLVED',
    'CANCELLED',
    'ESCALATED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "SOSEscalationStatus" AS ENUM (
    'PENDING',
    'EXECUTED',
    'SKIPPED',
    'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterEnum (VisitorStatus.CANCELLED)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'VisitorStatus' AND e.enumlabel = 'CANCELLED'
  ) THEN
    ALTER TYPE "VisitorStatus" ADD VALUE 'CANCELLED';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "Visitor"
  ADD COLUMN IF NOT EXISTS "photoUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "checkedInByGuardId" TEXT,
  ADD COLUMN IF NOT EXISTS "checkedOutByGuardId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Visitor_checkedInByGuardId_idx" ON "Visitor"("checkedInByGuardId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Visitor_checkedOutByGuardId_idx" ON "Visitor"("checkedOutByGuardId");

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "Visitor"
    ADD CONSTRAINT "Visitor_checkedInByGuardId_fkey"
    FOREIGN KEY ("checkedInByGuardId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Visitor"
    ADD CONSTRAINT "Visitor_checkedOutByGuardId_fkey"
    FOREIGN KEY ("checkedOutByGuardId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
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

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VisitorCheckpoint_visitorId_timestamp_idx" ON "VisitorCheckpoint"("visitorId", "timestamp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VisitorCheckpoint_actorUserId_idx" ON "VisitorCheckpoint"("actorUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "VisitorCheckpoint_checkpointType_idx" ON "VisitorCheckpoint"("checkpointType");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "VisitorCheckpoint"
    ADD CONSTRAINT "VisitorCheckpoint_visitorId_fkey"
    FOREIGN KEY ("visitorId") REFERENCES "Visitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "VisitorCheckpoint"
    ADD CONSTRAINT "VisitorCheckpoint_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
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

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SOSCheckpoint_alertId_timestamp_idx" ON "SOSCheckpoint"("alertId", "timestamp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SOSCheckpoint_actorUserId_idx" ON "SOSCheckpoint"("actorUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SOSCheckpoint_checkpointType_idx" ON "SOSCheckpoint"("checkpointType");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "SOSCheckpoint"
    ADD CONSTRAINT "SOSCheckpoint_alertId_fkey"
    FOREIGN KEY ("alertId") REFERENCES "SOSAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SOSCheckpoint"
    ADD CONSTRAINT "SOSCheckpoint_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "SOSEscalation" (
  "id" TEXT NOT NULL,
  "alertId" TEXT NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "processedAt" TIMESTAMP(3),
  "status" "SOSEscalationStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SOSEscalation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SOSEscalation_alertId_idx" ON "SOSEscalation"("alertId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SOSEscalation_scheduledAt_status_idx" ON "SOSEscalation"("scheduledAt", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SOSEscalation_status_idx" ON "SOSEscalation"("status");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "SOSEscalation"
    ADD CONSTRAINT "SOSEscalation_alertId_fkey"
    FOREIGN KEY ("alertId") REFERENCES "SOSAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
