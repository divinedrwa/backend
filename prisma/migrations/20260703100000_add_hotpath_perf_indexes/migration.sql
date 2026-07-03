-- Hot-path indexes surfaced by the performance review (additive; CREATE INDEX only).

-- Visitor: mobile visitor lists + guard dashboard order/filter by the
-- checkInTime/checkOutTime alias columns (distinct from checkInAt/checkOutAt).
CREATE INDEX IF NOT EXISTS "Visitor_societyId_checkInTime_idx"
  ON "Visitor"("societyId", "checkInTime");

CREATE INDEX IF NOT EXISTS "Visitor_societyId_checkOutTime_idx"
  ON "Visitor"("societyId", "checkOutTime");

-- WaterSupplyEvent: /water-supply/status does findMany distinct:["gateId"] orderBy createdAt.
CREATE INDEX IF NOT EXISTS "WaterSupplyEvent_societyId_gateId_createdAt_idx"
  ON "WaterSupplyEvent"("societyId", "gateId", "createdAt");

-- GarbageCollectionEvent: /garbage-collection/active does findFirst where exitTime:null orderBy entryTime.
CREATE INDEX IF NOT EXISTS "GarbageCollectionEvent_societyId_exitTime_entryTime_idx"
  ON "GarbageCollectionEvent"("societyId", "exitTime", "entryTime");

-- Document: /residents/my-documents (once capped) orders by createdAt within a society.
CREATE INDEX IF NOT EXISTS "Document_societyId_createdAt_idx"
  ON "Document"("societyId", "createdAt");
