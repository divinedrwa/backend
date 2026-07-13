-- L2: consent & terms versioning — additive, safe for production.
-- New append-only table; no changes to existing columns. Existing users have no row,
-- which correctly means "has not accepted current versions" → re-acceptance prompted
-- by updated clients (old clients ignore the new login field and keep working).

CREATE TABLE IF NOT EXISTS "UserLegalConsent" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "termsVersion"   TEXT NOT NULL,
  "privacyVersion" TEXT NOT NULL,
  "acceptedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress"      TEXT,
  "userAgent"      TEXT,
  "appVersion"     TEXT,
  CONSTRAINT "UserLegalConsent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "UserLegalConsent_userId_idx"
  ON "UserLegalConsent"("userId");

CREATE INDEX IF NOT EXISTS "UserLegalConsent_userId_acceptedAt_idx"
  ON "UserLegalConsent"("userId", "acceptedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserLegalConsent_userId_fkey'
  ) THEN
    ALTER TABLE "UserLegalConsent"
      ADD CONSTRAINT "UserLegalConsent_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
