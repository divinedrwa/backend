-- Hot-path indexes surfaced by the performance review.
-- VillaMaintenanceSnapshot: filtered by (cycleId, status) for pending dues.
CREATE INDEX IF NOT EXISTS "VillaMaintenanceSnapshot_cycleId_status_idx"
  ON "VillaMaintenanceSnapshot"("cycleId", "status");

-- UserNotification: unread-badge count filters by (userId, readAt IS NULL).
CREATE INDEX IF NOT EXISTS "UserNotification_userId_readAt_idx"
  ON "UserNotification"("userId", "readAt");
