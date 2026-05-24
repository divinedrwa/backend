-- AlterTable: Add preApprovedId to Visitor
ALTER TABLE "Visitor" ADD COLUMN "preApprovedId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Visitor_preApprovedId_key" ON "Visitor"("preApprovedId");

-- AddForeignKey
ALTER TABLE "Visitor" ADD CONSTRAINT "Visitor_preApprovedId_fkey" FOREIGN KEY ("preApprovedId") REFERENCES "PreApprovedVisitor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Fix SOSAlert FK to allow SET NULL
ALTER TABLE "SOSAlert" DROP CONSTRAINT IF EXISTS "SOSAlert_triggeredBy_fkey";
ALTER TABLE "SOSAlert" ADD CONSTRAINT "SOSAlert_triggeredBy_fkey" FOREIGN KEY ("triggeredBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Fix user_payments FK to allow SET NULL
ALTER TABLE "user_payments" DROP CONSTRAINT IF EXISTS "user_payments_userId_fkey";
ALTER TABLE "user_payments" ADD CONSTRAINT "user_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Additional performance indexes
CREATE INDEX IF NOT EXISTS "GuardPatrol_scheduledTime_idx" ON "GuardPatrol"("scheduledTime");
CREATE INDEX IF NOT EXISTS "GuardPatrol_societyId_guardId_idx" ON "GuardPatrol"("societyId", "guardId");
CREATE INDEX IF NOT EXISTS "GuardPatrol_societyId_status_idx" ON "GuardPatrol"("societyId", "status");
CREATE INDEX IF NOT EXISTS "MaintenanceCollectionCycle_societyId_status_idx" ON "MaintenanceCollectionCycle"("societyId", "status");
CREATE INDEX IF NOT EXISTS "PreApprovedVisitor_societyId_otp_isActive_isUsed_idx" ON "PreApprovedVisitor"("societyId", "otp", "isActive", "isUsed");
