-- Idempotent: grandfather existing active societies as ACTIVE subscriptions (no trial expiry).
-- Safe to run on every deploy; skips societies that already have a row.
INSERT INTO "SocietySubscription" (
  "id",
  "societyId",
  "plan",
  "status",
  "trialEndsAt",
  "currentPeriodEnd",
  "notes",
  "createdAt",
  "updatedAt"
)
SELECT
  'csub_' || substr(md5(s."id" || ':backfill'), 1, 24),
  s."id",
  'STARTER'::"SocietySubscriptionPlan",
  'ACTIVE'::"SocietySubscriptionStatus",
  NULL,
  NULL,
  'Auto-backfilled for pre-subscription tenant',
  NOW(),
  NOW()
FROM "Society" s
WHERE s."archivedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "SocietySubscription" ss WHERE ss."societyId" = s."id"
  );
