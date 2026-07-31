-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN "photoUrl" TEXT;

-- AlterTable
ALTER TABLE "FamilyMember" ADD COLUMN "canApproveVisitors" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FamilyMember" ADD COLUMN "linkedUserId" TEXT;

-- CreateIndex
CREATE INDEX "FamilyMember_linkedUserId_idx" ON "FamilyMember"("linkedUserId");

-- AddForeignKey
ALTER TABLE "FamilyMember" ADD CONSTRAINT "FamilyMember_linkedUserId_fkey" FOREIGN KEY ("linkedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
