-- When a refresh token was revoked by rotation; enables a short reuse grace window.
ALTER TABLE "RefreshToken" ADD COLUMN IF NOT EXISTS "rotatedAt" TIMESTAMP(3);
