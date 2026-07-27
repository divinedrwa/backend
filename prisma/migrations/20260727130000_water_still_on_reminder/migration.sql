-- Track whether the "motor still ON after N minutes" reminder was sent (or
-- suppressed because the gate was turned OFF / superseded before the deadline).
ALTER TABLE "WaterSupplyEvent" ADD COLUMN "stillOnReminderSentAt" TIMESTAMP(3);

CREATE INDEX "WaterSupplyEvent_turnedOn_stillOnReminderSentAt_createdAt_idx"
  ON "WaterSupplyEvent"("turnedOn", "stillOnReminderSentAt", "createdAt");
