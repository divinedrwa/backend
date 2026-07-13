-- L3: per-category notification preferences — additive, safe for production.
-- New table only; no changes to existing columns. Absence of a row means the category
-- is enabled (default), so existing users keep receiving everything until they opt out.

CREATE TABLE IF NOT EXISTS "NotificationCategoryPreference" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "category"    "NotificationCategory" NOT NULL,
  "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationCategoryPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NotificationCategoryPreference_userId_category_key"
  ON "NotificationCategoryPreference"("userId", "category");

CREATE INDEX IF NOT EXISTS "NotificationCategoryPreference_userId_idx"
  ON "NotificationCategoryPreference"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'NotificationCategoryPreference_userId_fkey'
  ) THEN
    ALTER TABLE "NotificationCategoryPreference"
      ADD CONSTRAINT "NotificationCategoryPreference_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
