-- Fix-forward for 20260608110000_add_performance_indexes.
--
-- Why this exists:
--   The June perf-index migration referenced identifiers that do not exist
--   ("UserCyclePayment"/"billingCycleId", "VillaMaintenanceSnapshot"."billingCycleId",
--    a non-existent "User"."archivedAt"). On a fresh database that migration ERRORS at
--   the first bad statement, so it could never have executed end-to-end. On the shared
--   production DB it was recorded as applied via `prisma:baseline` (SQL never run), which
--   means these indexes are ABSENT in production today.
--
--   The historical migration file has since been corrected in place so fresh local setups
--   (`prisma:migrate:local`) succeed — but `migrate deploy` will not re-run an already-applied
--   migration, so production would never receive the indexes. This additive, idempotent
--   migration closes that gap. It is a no-op wherever the indexes already exist.
--
-- Safety: every statement is CREATE INDEX IF NOT EXISTS — additive, no DROP/TRUNCATE.
--   Indexes are created without CONCURRENTLY (Prisma wraps migrations in a transaction);
--   deploy during low-traffic hours. Each is a brief lock (~seconds).

-- 1. Visitor phone lookup (guard check-in, pre-approved verification)
CREATE INDEX IF NOT EXISTS "idx_visitor_phone"
  ON "Visitor"("phone");

-- 2. Maintenance payment date queries (financial reports, dashboards)
CREATE INDEX IF NOT EXISTS "idx_maintenance_payment_date"
  ON "MaintenancePayment"("paymentDate", "societyId");

-- 3. Billing cycle user payments (pending dues) — table user_payments, FK cycleId
CREATE INDEX IF NOT EXISTS "idx_ucp_billing_cycle"
  ON "user_payments"("cycleId", "userId");

-- 4. Active push devices (notification delivery)
CREATE INDEX IF NOT EXISTS "idx_push_device_active"
  ON "PushDevice"("userId", "isActive")
  WHERE "isActive" = true;

-- 5. Active SOS alerts (guard dashboard, real-time monitoring)
CREATE INDEX IF NOT EXISTS "idx_sos_active"
  ON "SOSAlert"("societyId", "status")
  WHERE "status" IN ('CREATED', 'ACKNOWLEDGED', 'IN_PROGRESS');

-- 6. Complaint SLA tracking (admin complaint dashboard)
CREATE INDEX IF NOT EXISTS "idx_complaint_sla"
  ON "Complaint"("societyId", "status", "priority", "createdAt");

-- 7. Pre-approved visitor OTP lookup (guard OTP verification)
CREATE INDEX IF NOT EXISTS "idx_preapproved_otp"
  ON "PreApprovedVisitor"("otp", "validUntil")
  WHERE "usedAt" IS NULL AND "isActive" = true;

-- 8. Villa maintenance snapshots (billing cycle processing) — FK cycleId
CREATE INDEX IF NOT EXISTS "idx_villa_snapshot_cycle"
  ON "VillaMaintenanceSnapshot"("cycleId", "villaId");

-- 9. User society role lookups (auth, permission checks)
CREATE INDEX IF NOT EXISTS "idx_user_society_role"
  ON "User"("societyId", "role", "isActive")
  WHERE "isActive" = true;

-- 10. Parcel pending collection (resident parcel list)
CREATE INDEX IF NOT EXISTS "idx_parcel_pending"
  ON "Parcel"("villaId", "status", "receivedAt");
