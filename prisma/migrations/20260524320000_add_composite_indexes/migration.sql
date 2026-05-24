-- CreateIndex
CREATE INDEX "Gate_societyId_isActive_idx" ON "Gate"("societyId", "isActive");

-- CreateIndex
CREATE INDEX "Amenity_societyId_isActive_idx" ON "Amenity"("societyId", "isActive");

-- CreateIndex
CREATE INDEX "Staff_societyId_isActive_idx" ON "Staff"("societyId", "isActive");
