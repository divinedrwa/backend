-- CreateTable
CREATE TABLE "WaterSupplyRequest" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gateId" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaterSupplyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaterSupplyRequest_societyId_idx" ON "WaterSupplyRequest"("societyId");

-- CreateIndex
CREATE INDEX "WaterSupplyRequest_userId_idx" ON "WaterSupplyRequest"("userId");

-- CreateIndex
CREATE INDEX "WaterSupplyRequest_status_idx" ON "WaterSupplyRequest"("status");

-- CreateIndex
CREATE INDEX "WaterSupplyRequest_createdAt_idx" ON "WaterSupplyRequest"("createdAt");

-- AddForeignKey
ALTER TABLE "WaterSupplyRequest" ADD CONSTRAINT "WaterSupplyRequest_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaterSupplyRequest" ADD CONSTRAINT "WaterSupplyRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaterSupplyRequest" ADD CONSTRAINT "WaterSupplyRequest_gateId_fkey" FOREIGN KEY ("gateId") REFERENCES "Gate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaterSupplyRequest" ADD CONSTRAINT "WaterSupplyRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
