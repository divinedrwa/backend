-- Tables created after 20260701100000_enable_rls_society_subscription were missing RLS.
-- Supabase PostgREST (anon/authenticated) could read/write them without policies.
-- Express/Prisma uses the postgres role (table owner) and is unaffected.

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
  END LOOP;
END
$$;
