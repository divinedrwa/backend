-- Allow duplicate (societyId, phone) on User for residents/guards imports and multi-villa accounts.
-- Idempotent: fixes DBs that still have the partial unique index from 20260504190000, e.g. if
-- 20260507104500 was never applied on that database or the index was recreated.

DROP INDEX IF EXISTS "User_phone_societyId_key";

-- Drop any other unique index on "User" that enforces (societyId, phone) under a different name.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT ns.nspname AS schemaname, ic.relname AS indexname
    FROM pg_index i
    JOIN pg_class tc ON tc.oid = i.indrelid
    JOIN pg_namespace ns ON ns.oid = tc.relnamespace
    JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE ns.nspname = 'public'
      AND tc.relname = 'User'
      AND i.indisunique
      AND NOT i.indisprimary
      AND pg_get_indexdef(i.indexrelid) LIKE '%societyId%'
      AND pg_get_indexdef(i.indexrelid) LIKE '%phone%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', r.schemaname, r.indexname);
  END LOOP;
END $$;
