-- Approved vehicle registry: categories, guard search digits, backfill resident vehicles.

CREATE TYPE "VehicleRegistrationCategory" AS ENUM ('RESIDENT', 'VISITOR', 'OTHER');
CREATE TYPE "VehicleRegistrationSource" AS ENUM ('RESIDENT', 'ADMIN');
CREATE TYPE "VehicleApprovalStatus" AS ENUM ('APPROVED', 'SUSPENDED');

ALTER TABLE "Vehicle" ADD COLUMN "registrationDigits" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Vehicle" ADD COLUMN "registrationCategory" "VehicleRegistrationCategory" NOT NULL DEFAULT 'RESIDENT';
ALTER TABLE "Vehicle" ADD COLUMN "source" "VehicleRegistrationSource" NOT NULL DEFAULT 'RESIDENT';
ALTER TABLE "Vehicle" ADD COLUMN "status" "VehicleApprovalStatus" NOT NULL DEFAULT 'APPROVED';
ALTER TABLE "Vehicle" ADD COLUMN "ownerLabel" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN "notes" TEXT;

ALTER TABLE "Vehicle" ALTER COLUMN "villaId" DROP NOT NULL;

-- Backfill digits + mark all existing rows as approved resident registry entries.
UPDATE "Vehicle"
SET
  "registrationDigits" = regexp_replace(upper("registrationNumber"), '[^0-9]', '', 'g'),
  "registrationCategory" = 'RESIDENT',
  "source" = 'RESIDENT',
  "status" = 'APPROVED';

CREATE INDEX "Vehicle_societyId_status_idx" ON "Vehicle"("societyId", "status");
CREATE INDEX "Vehicle_societyId_registrationDigits_idx" ON "Vehicle"("societyId", "registrationDigits");
CREATE INDEX "Vehicle_societyId_registrationCategory_idx" ON "Vehicle"("societyId", "registrationCategory");
