-- Repair schema drift when _prisma_migrations lists migrations as applied but DDL never ran
-- (e.g. prisma migrate resolve, prisma:baseline, or wrong DATABASE_URL during deploy).
-- Fully idempotent — safe to run even if 20260527120000_visitor_checkpoint_sos_audit already applied.

-- ── Visitor centralization (photoUrl, guard audit, checkpoints) ─────────────────
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

ALTER TABLE "Visitor"
  ADD COLUMN IF NOT EXISTS "photoUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "checkedInByGuardId" TEXT,
  ADD COLUMN IF NOT EXISTS "checkedOutByGuardId" TEXT,
  ADD COLUMN IF NOT EXISTS "preApprovedId" TEXT;

CREATE INDEX IF NOT EXISTS "Visitor_checkedInByGuardId_idx" ON "Visitor"("checkedInByGuardId");
CREATE INDEX IF NOT EXISTS "Visitor_checkedOutByGuardId_idx" ON "Visitor"("checkedOutByGuardId");
CREATE UNIQUE INDEX IF NOT EXISTS "Visitor_preApprovedId_key" ON "Visitor"("preApprovedId");

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

DO $$ BEGIN
  ALTER TABLE "Visitor"
    ADD CONSTRAINT "Visitor_preApprovedId_fkey"
    FOREIGN KEY ("preApprovedId") REFERENCES "PreApprovedVisitor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

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

CREATE INDEX IF NOT EXISTS "VisitorCheckpoint_visitorId_timestamp_idx" ON "VisitorCheckpoint"("visitorId", "timestamp");
CREATE INDEX IF NOT EXISTS "VisitorCheckpoint_actorUserId_idx" ON "VisitorCheckpoint"("actorUserId");
CREATE INDEX IF NOT EXISTS "VisitorCheckpoint_checkpointType_idx" ON "VisitorCheckpoint"("checkpointType");

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

-- ── SOS audit tables ────────────────────────────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS "SOSCheckpoint_alertId_timestamp_idx" ON "SOSCheckpoint"("alertId", "timestamp");
CREATE INDEX IF NOT EXISTS "SOSCheckpoint_actorUserId_idx" ON "SOSCheckpoint"("actorUserId");
CREATE INDEX IF NOT EXISTS "SOSCheckpoint_checkpointType_idx" ON "SOSCheckpoint"("checkpointType");

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

CREATE TABLE IF NOT EXISTS "SOSEscalation" (
  "id" TEXT NOT NULL,
  "alertId" TEXT NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "processedAt" TIMESTAMP(3),
  "status" "SOSEscalationStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SOSEscalation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SOSEscalation_alertId_idx" ON "SOSEscalation"("alertId");
CREATE INDEX IF NOT EXISTS "SOSEscalation_scheduledAt_status_idx" ON "SOSEscalation"("scheduledAt", "status");
CREATE INDEX IF NOT EXISTS "SOSEscalation_status_idx" ON "SOSEscalation"("status");

DO $$ BEGIN
  ALTER TABLE "SOSEscalation"
    ADD CONSTRAINT "SOSEscalation_alertId_fkey"
    FOREIGN KEY ("alertId") REFERENCES "SOSAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── Maintenance / billing columns (common baseline gaps) ───────────────────────
DO $$ BEGIN
  CREATE TYPE "MaintenanceBillingRole" AS ENUM ('PRIMARY', 'SECONDARY', 'EXCLUDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "maintenanceBillingRole" "MaintenanceBillingRole" NOT NULL DEFAULT 'PRIMARY';

ALTER TABLE "Society"
  ADD COLUMN IF NOT EXISTS "lateFeePercentage" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lateFeeFixedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maintenanceGracePeriodDays" INTEGER NOT NULL DEFAULT 15;

ALTER TABLE "VillaMaintenanceSnapshot"
  ADD COLUMN IF NOT EXISTS "lateFeeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lateFeeAppliedAt" TIMESTAMP(3);
