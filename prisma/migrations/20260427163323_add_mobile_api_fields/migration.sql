/*
  Warnings:

  - Added the required column `residentId` to the `EmergencyContact` table without a default value. This is not possible if the table is not empty.
  - Added the required column `residentId` to the `FamilyMember` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ResidentType" AS ENUM ('OWNER', 'TENANT', 'FAMILY_MEMBER');

-- AlterTable
ALTER TABLE "Amenity" ADD COLUMN     "location" TEXT;

-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN     "adminNotes" TEXT,
ADD COLUMN     "category" TEXT DEFAULT 'General',
ADD COLUMN     "residentId" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EmergencyContact" ADD COLUMN     "address" TEXT,
ADD COLUMN     "relationship" TEXT,
ADD COLUMN     "residentId" TEXT NOT NULL,
ALTER COLUMN "villaId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "FamilyMember" ADD COLUMN     "idProof" TEXT,
ADD COLUMN     "relationship" TEXT,
ADD COLUMN     "residentId" TEXT NOT NULL,
ALTER COLUMN "villaId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "MaintenancePayment" ADD COLUMN     "maintenanceId" TEXT;

-- AlterTable
ALTER TABLE "Parcel" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryService" TEXT,
ADD COLUMN     "senderName" TEXT,
ADD COLUMN     "trackingNumber" TEXT;

-- AlterTable
ALTER TABLE "PreApprovedVisitor" ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "visitorType" "VisitorType" NOT NULL DEFAULT 'GUEST',
ALTER COLUMN "validFrom" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "validUntil" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "residentType" "ResidentType" NOT NULL DEFAULT 'OWNER';

-- AlterTable
ALTER TABLE "Visitor" ADD COLUMN     "checkInTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "checkOutTime" TIMESTAMP(3),
ADD COLUMN     "photo" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'CHECKED_IN';

-- CreateIndex
CREATE INDEX "Complaint_residentId_idx" ON "Complaint"("residentId");

-- CreateIndex
CREATE INDEX "Complaint_status_idx" ON "Complaint"("status");

-- CreateIndex
CREATE INDEX "Complaint_category_idx" ON "Complaint"("category");

-- CreateIndex
CREATE INDEX "EmergencyContact_residentId_idx" ON "EmergencyContact"("residentId");

-- CreateIndex
CREATE INDEX "FamilyMember_residentId_idx" ON "FamilyMember"("residentId");

-- CreateIndex
CREATE INDEX "MaintenancePayment_maintenanceId_idx" ON "MaintenancePayment"("maintenanceId");

-- CreateIndex
CREATE INDEX "Parcel_status_idx" ON "Parcel"("status");

-- CreateIndex
CREATE INDEX "PreApprovedVisitor_isActive_idx" ON "PreApprovedVisitor"("isActive");

-- CreateIndex
CREATE INDEX "PreApprovedVisitor_approvedById_idx" ON "PreApprovedVisitor"("approvedById");

-- CreateIndex
CREATE INDEX "User_residentType_idx" ON "User"("residentType");

-- CreateIndex
CREATE INDEX "Visitor_status_idx" ON "Visitor"("status");

-- AddForeignKey
ALTER TABLE "MaintenancePayment" ADD CONSTRAINT "MaintenancePayment_maintenanceId_fkey" FOREIGN KEY ("maintenanceId") REFERENCES "Maintenance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_residentId_fkey" FOREIGN KEY ("residentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreApprovedVisitor" ADD CONSTRAINT "PreApprovedVisitor_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyMember" ADD CONSTRAINT "FamilyMember_residentId_fkey" FOREIGN KEY ("residentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyContact" ADD CONSTRAINT "EmergencyContact_residentId_fkey" FOREIGN KEY ("residentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
