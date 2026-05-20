-- Enable Row Level Security on all application tables.
--
-- Supabase exposes a PostgREST API using the anon / authenticated roles.
-- With RLS enabled and NO policies for those roles, every PostgREST query
-- returns zero rows — data is only reachable through the Express backend,
-- which connects as the `postgres` role (table owner, bypasses RLS).

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
  END LOOP;
END
$$;
