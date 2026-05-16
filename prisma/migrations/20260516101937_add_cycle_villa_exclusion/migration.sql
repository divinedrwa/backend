-- CreateTable
CREATE TABLE "CycleVillaExclusion" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "reason" TEXT,
    "excludedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CycleVillaExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CycleVillaExclusion_cycleId_idx" ON "CycleVillaExclusion"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "CycleVillaExclusion_cycleId_villaId_key" ON "CycleVillaExclusion"("cycleId", "villaId");

-- AddForeignKey
ALTER TABLE "CycleVillaExclusion" ADD CONSTRAINT "CycleVillaExclusion_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "MaintenanceCollectionCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleVillaExclusion" ADD CONSTRAINT "CycleVillaExclusion_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleVillaExclusion" ADD CONSTRAINT "CycleVillaExclusion_excludedBy_fkey" FOREIGN KEY ("excludedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
