# Deploy checklist (Render + Supabase)

Why this exists: a push that added a database column went live without the column, and every
screen that read villas failed until it was added by hand. Migrations are applied by the
`predeploy` script, so Render has to run it, and be able to reach the database to do so.

## One-time Render setup (backend service)

1. **Settings → Pre-Deploy Command:** `npm run predeploy`
   It runs: `prisma generate` → migration safety check → `prisma migrate deploy` (with retries)
   → subscription backfill. Render only switches to the new version if it succeeds, so a failed
   migration keeps the old version live instead of breaking it.
2. **Environment → `DIRECT_URL`:** use the Supabase **session pooler** (port 5432), not the
   direct `db.<project>.supabase.co` host. The direct host is IPv6-only and Render cannot reach it,
   so migrations would fail. Format:
   `postgresql://postgres.<project-ref>:<password>@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres`
   `DATABASE_URL` stays on the transaction pooler (port 6543, `?pgbouncer=true`); Prisma uses
   `DIRECT_URL` for migrations only (`directUrl` in `prisma/schema.prisma`).
3. **Settings → Auto-Deploy:** choose **After CI checks pass**, so the GitHub Actions workflow in
   `.github/workflows/ci.yml` gates every deploy.

## Before the first pre-deploy run

Run `docs/check-supabase-migrations.sql` in the Supabase SQL editor. Migrations applied by hand
are not recorded, so the first pre-deploy run applies them again; they all use `IF NOT EXISTS`, so
this is safe and records them.

## After every deploy that adds a migration

- Render deploy log shows `[migrate-retry] migrations applied successfully.`
- Open one screen that reads the new column (for a villa change: guard **Add visitor**).
- If a column was ever added by hand, restart the Render service afterwards; running instances keep
  old pooled connections and keep failing until restarted.

## Known schema differences (to resolve against production)

A fresh database built from the migrations differs from `prisma/schema.prisma` in two places:

- `Parcel.status` default: migrations give `PENDING`, the schema says `RECEIVED`.
- `Vehicle.villaId` foreign key: the schema says `ON DELETE SET NULL ON UPDATE CASCADE`.

Check what production has, then add one migration that makes the files match. Until then the CI
step "Schema matches migrations" is informational (`continue-on-error`); remove that flag once
fixed so any future drift fails the build.
