-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "villaId" TEXT;

-- CreateIndex
CREATE INDEX "Invitation_villaId_idx" ON "Invitation"("villaId");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE SET NULL ON UPDATE CASCADE;
