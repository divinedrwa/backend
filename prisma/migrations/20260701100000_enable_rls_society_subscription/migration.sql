-- SocietySubscription was created after 20260520074500_enable_rls_all_tables.
-- Enable RLS so PostgREST (anon/authenticated) cannot read/write subscription rows.
-- Express/Prisma uses the postgres role (table owner) and is unaffected.

ALTER TABLE public."SocietySubscription" ENABLE ROW LEVEL SECURITY;
