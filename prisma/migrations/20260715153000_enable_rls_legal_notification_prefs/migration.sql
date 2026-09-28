-- Reconstructed on 2026-09-28 from the production schema; the original file was lost.
-- Tables created after 20260701100000_enable_rls_society_subscription need RLS so
-- Supabase PostgREST (anon/authenticated) cannot read/write them. Prisma uses the owner role and is unaffected.

ALTER TABLE public."UserLegalConsent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."NotificationCategoryPreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."villa_ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."credit_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."late_fee_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."reminder_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MaintenanceLineItemTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MaintenanceLineItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MaintenanceLateFeeWaiver" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BankStatementUpload" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BankStatementRow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."project_installments" ENABLE ROW LEVEL SECURITY;
