-- CreateEnum
CREATE TYPE "VisitorWrongEntryStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'DISMISSED');

-- CreateTable
CREATE TABLE "VisitorWrongEntryReport" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "reportedByUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "residentNote" TEXT,
    "status" "VisitorWrongEntryStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitorWrongEntryReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VisitorWrongEntryReport_visitorId_reportedByUserId_key" ON "VisitorWrongEntryReport"("visitorId", "reportedByUserId");

-- CreateIndex
CREATE INDEX "VisitorWrongEntryReport_societyId_status_idx" ON "VisitorWrongEntryReport"("societyId", "status");

-- CreateIndex
CREATE INDEX "VisitorWrongEntryReport_visitorId_idx" ON "VisitorWrongEntryReport"("visitorId");

-- CreateIndex
CREATE INDEX "VisitorWrongEntryReport_reportedByUserId_idx" ON "VisitorWrongEntryReport"("reportedByUserId");

-- CreateIndex
CREATE INDEX "VisitorWrongEntryReport_societyId_createdAt_idx" ON "VisitorWrongEntryReport"("societyId", "createdAt");

-- AddForeignKey
ALTER TABLE "VisitorWrongEntryReport" ADD CONSTRAINT "VisitorWrongEntryReport_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorWrongEntryReport" ADD CONSTRAINT "VisitorWrongEntryReport_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "Visitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorWrongEntryReport" ADD CONSTRAINT "VisitorWrongEntryReport_reportedByUserId_fkey" FOREIGN KEY ("reportedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitorWrongEntryReport" ADD CONSTRAINT "VisitorWrongEntryReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
