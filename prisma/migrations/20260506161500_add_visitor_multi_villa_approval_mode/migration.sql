-- Create enum for society-level multi-villa approval policy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'VisitorMultiVillaApprovalMode'
      AND n.nspname = 'public'
  ) THEN
    CREATE TYPE "VisitorMultiVillaApprovalMode" AS ENUM (
      'ANY_ONE_APPROVAL',
      'ALL_VILLAS_REQUIRED'
    );
  END IF;
END
$$;

-- Add policy column to Society if missing.
ALTER TABLE "Society"
ADD COLUMN IF NOT EXISTS "visitorMultiVillaApprovalMode"
"VisitorMultiVillaApprovalMode" NOT NULL DEFAULT 'ANY_ONE_APPROVAL';
