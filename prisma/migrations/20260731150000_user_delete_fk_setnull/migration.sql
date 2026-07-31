-- Allow user delete when guards have visitor checkpoint / banner / billing exclusion history.
ALTER TABLE "VisitorCheckpoint" ALTER COLUMN "actorUserId" DROP NOT NULL;
ALTER TABLE "VisitorCheckpoint" DROP CONSTRAINT IF EXISTS "VisitorCheckpoint_actorUserId_fkey";
ALTER TABLE "VisitorCheckpoint" ADD CONSTRAINT "VisitorCheckpoint_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Banner" ALTER COLUMN "createdBy" DROP NOT NULL;
ALTER TABLE "Banner" DROP CONSTRAINT IF EXISTS "Banner_createdBy_fkey";
ALTER TABLE "Banner" ADD CONSTRAINT "Banner_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CycleVillaExclusion" ALTER COLUMN "excludedBy" DROP NOT NULL;
ALTER TABLE "CycleVillaExclusion" DROP CONSTRAINT IF EXISTS "CycleVillaExclusion_excludedBy_fkey";
ALTER TABLE "CycleVillaExclusion" ADD CONSTRAINT "CycleVillaExclusion_excludedBy_fkey"
  FOREIGN KEY ("excludedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
