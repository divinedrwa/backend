-- CreateEnum
CREATE TYPE "BillingAccountScope" AS ENUM ('PROPERTY');

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "unitCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAccount" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "scope" "BillingAccountScope" NOT NULL DEFAULT 'PROPERTY',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "User" ADD COLUMN "unitId" TEXT;

-- AlterTable
ALTER TABLE "VisitorVilla" ADD COLUMN "unitId" TEXT,
ADD COLUMN "residentUserId" TEXT;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAccount" ADD CONSTRAINT "BillingAccount_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAccount" ADD CONSTRAINT "BillingAccount_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccount_villaId_key" ON "BillingAccount"("villaId");

-- CreateIndex
CREATE INDEX "BillingAccount_societyId_idx" ON "BillingAccount"("societyId");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_villaId_unitCode_key" ON "Unit"("villaId", "unitCode");

-- CreateIndex
CREATE INDEX "Unit_societyId_idx" ON "Unit"("societyId");

-- CreateIndex
CREATE INDEX "Unit_villaId_idx" ON "Unit"("villaId");

-- One default unit per existing villa (stable id for FK backfill)
INSERT INTO "Unit" ("id", "societyId", "villaId", "unitCode", "label", "sortOrder", "isDefault", "createdAt", "updatedAt")
SELECT
    'udef_' || v."id",
    v."societyId",
    v."id",
    '_DEFAULT',
    'Default',
    0,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Villa" v;

-- One billing account per property (villa)
INSERT INTO "BillingAccount" ("id", "societyId", "villaId", "scope", "createdAt", "updatedAt")
SELECT
    'bacct_' || v."id",
    v."societyId",
    v."id",
    'PROPERTY',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Villa" v;

-- Residents: attach to default unit when they have a villa
UPDATE "User" u
SET "unitId" = ut."id"
FROM "Unit" ut
WHERE ut."villaId" = u."villaId"
  AND ut."isDefault" = true
  AND u."villaId" IS NOT NULL;

-- Visitor rows: default unit for legacy visits
UPDATE "VisitorVilla" vv
SET "unitId" = ut."id"
FROM "Unit" ut
WHERE ut."villaId" = vv."villaId"
  AND ut."isDefault" = true;

ALTER TABLE "VisitorVilla" ALTER COLUMN "unitId" SET NOT NULL;

-- Drop old unique, add composite unique including unit
ALTER TABLE "VisitorVilla" DROP CONSTRAINT IF EXISTS "VisitorVilla_visitorId_villaId_key";

CREATE UNIQUE INDEX "VisitorVilla_visitorId_villaId_unitId_key" ON "VisitorVilla"("visitorId", "villaId", "unitId");

-- CreateIndex
CREATE INDEX "User_unitId_idx" ON "User"("unitId");

-- CreateIndex
CREATE INDEX "VisitorVilla_unitId_idx" ON "VisitorVilla"("unitId");

-- CreateIndex
CREATE INDEX "VisitorVilla_residentUserId_idx" ON "VisitorVilla"("residentUserId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorVilla" ADD CONSTRAINT "VisitorVilla_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorVilla" ADD CONSTRAINT "VisitorVilla_residentUserId_fkey" FOREIGN KEY ("residentUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
