-- Why and when a device stopped receiving alerts (LOGGED_OUT / UNINSTALLED), for install/uninstall analytics.
ALTER TABLE "PushDevice" ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3);
ALTER TABLE "PushDevice" ADD COLUMN IF NOT EXISTS "deactivatedReason" TEXT;
CREATE INDEX IF NOT EXISTS "PushDevice_deactivatedAt_idx" ON "PushDevice"("deactivatedAt");
