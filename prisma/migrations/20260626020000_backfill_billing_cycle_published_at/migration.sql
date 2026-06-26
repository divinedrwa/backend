-- Backfill publishedAt for cycles created before resident-visibility gating shipped.
--
-- Before this release, residents saw every billing cycle regardless of publishedAt.
-- This release adds publishedBillingCycleFilter ({ publishedAt: { not: null } }) to all
-- resident-facing queries, so any cycle with publishedAt IS NULL becomes invisible to
-- residents (dues, dashboards, history, pay flows). Existing live cycles have
-- publishedAt = NULL (the column was added 2026-06-02 with no default/backfill and cycle
-- creation never set it), so without this backfill they would vanish on deploy.
--
-- Mark every existing cycle as published using its createdAt timestamp. This is
-- idempotent (only touches NULL rows) and only relaxes visibility, so it cannot hide
-- anything currently shown. New cycles continue to default to draft (publishedAt NULL)
-- until an admin explicitly publishes them — the intended new workflow.
UPDATE "BillingCycle"
SET "publishedAt" = COALESCE("publishedAt", "createdAt")
WHERE "publishedAt" IS NULL;
