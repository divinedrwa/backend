-- Backfill compatibility for environments with partial legacy schema.

-- Ensure enum exists before adding User.residentType.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'ResidentType'
      AND n.nspname = 'public'
  ) THEN
    CREATE TYPE "ResidentType" AS ENUM ('OWNER', 'TENANT', 'FAMILY_MEMBER');
  END IF;
END
$$;

-- User profile fields used by Prisma model and seed path.
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "residentType" "ResidentType" NOT NULL DEFAULT 'OWNER',
ADD COLUMN IF NOT EXISTS "notifyEmail" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "photoUrl" TEXT;

-- SUPER_ADMIN support requires nullable tenant binding.
ALTER TABLE "User"
ALTER COLUMN "societyId" DROP NOT NULL;
