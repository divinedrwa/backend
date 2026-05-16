-- CreateIndex
CREATE INDEX "Visitor_societyId_checkOutAt_idx" ON "Visitor"("societyId", "checkOutAt");

-- CreateIndex
CREATE INDEX "Visitor_societyId_status_idx" ON "Visitor"("societyId", "status");
