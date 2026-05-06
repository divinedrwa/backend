-- CreateEnum
CREATE TYPE "SocietyStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- AlterTable
ALTER TABLE "Society" ADD COLUMN     "status" "SocietyStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Society" ADD COLUMN     "createdByUserId" TEXT;

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "token" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_token_key" ON "Invitation"("token");

-- CreateIndex
CREATE INDEX "Invitation_societyId_status_idx" ON "Invitation"("societyId", "status");

-- CreateIndex
CREATE INDEX "Society_status_idx" ON "Society"("status");

-- Partial unique: duplicate (societyId, phone) for non-null phone will FAIL this migration
CREATE UNIQUE INDEX "User_phone_societyId_key" ON "User" ("societyId", "phone")
WHERE ("phone" IS NOT NULL AND "phone" <> '');

-- AddForeignKey
ALTER TABLE "Society" ADD CONSTRAINT "Society_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill tenant on payment_logs from owning user (improves admin reporting / validation)
UPDATE "payment_logs" pl
SET "societyId" = u."societyId"
FROM "User" u
WHERE pl."userId" = u.id
  AND pl."societyId" IS NULL
  AND u."societyId" IS NOT NULL;
