# Society Admin Backend (Express + Prisma)

Backend API for the Admin Dashboard and Flutter app. Exposes REST endpoints under `/api`, uses PostgreSQL via Prisma, and supports role-based flows (`ADMIN`, `RESIDENT`, `GUARD`, optional `SUPER_ADMIN`).

## Stack

- Node.js + TypeScript
- Express
- Prisma + PostgreSQL
- JWT auth + bcrypt
- Zod validation

## Quick Start

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:

- `DATABASE_URL`
- `JWT_SECRET`
- `PORT` (optional, defaults to `4000`)

Then run:

```bash
npm run prisma:generate
```

If this is a **brand-new empty** Postgres database, create tables with:

```bash
npm run prisma:migrate
```

If the database **already has tables** (restored backup, shared Neon, production URL), do **not** run `prisma:migrate` — you will get **P3005**. Use **baselining** first (see [Deploy Notes — Error P3005](#error-p3005-database-schema-is-not-empty)), then only `npm run prisma:migrate:deploy` for future updates.

```bash
npm run prisma:seed
npm run dev
```

Health check:

```bash
curl http://localhost:4000/health
```

Expected:

```json
{"ok":true}
```

## Scripts

Common scripts from `package.json`:

- `npm run dev` - start API in watch mode (`tsx watch`)
- `npm run build` - compile TypeScript to `dist/`
- `npm run start` - run compiled server (`node dist/server.js`)
- `npm run prisma:generate` - Prisma client generation
- `npm run prisma:migrate` - `migrate dev` (empty dev DB only; avoid on non-empty DB — see P3005 below)
- `npm run prisma:migrate:deploy` - apply pending migrations (staging/production)
- `npm run prisma:baseline` - mark all migrations applied without SQL (existing DB that already matches schema)
- `npm run prisma:seed` - minimal seed (default society + admin)
- `npm run prisma:seed-demo` - full demo data
- `npm run db:wipe-admin` - destructive wipe + recreate admin seed
- `npm run smoke:http` - HTTP smoke checks
- `npm run test` - run tests in `src/**/*.test.ts`

## Seed Credentials

Default minimal seed creates a generic local admin:

- Email: `admin@society.local`
- Username: `admin`
- Password: `ChangeMe123!` (rotate immediately)

Override via env vars:

- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `ADMIN_USERNAME`
- `SOCIETY_NAME`

Optional **platform super admin** (web `/super-admin/login`, API `POST /api/auth/super-admin/login`) is **only** created when **both** of these are set; otherwise no `SUPER_ADMIN` user exists and sign-in will show “Invalid username or password”.

- `SUPER_ADMIN_EMAIL` (required for super admin)
- `SUPER_ADMIN_PASSWORD` (required for super admin)
- (optional) `SUPER_ADMIN_USERNAME` (default `super_admin` — you can sign in with this username or the email)
- (optional) `SUPER_ADMIN_NAME`

After setting them, run `npm run prisma:seed` (or your deploy seed step) against the same `DATABASE_URL` as the API.

For **local dev only**, you can add `SUPER_ADMIN_AUTO_SEED=true` to `.env` when `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` are unset: the seed uses fixed defaults (`superadmin@platform.local` / `SuperAdminChangeMe123!`) unless `NODE_ENV=production` (then the seed exits with an error). Rotate credentials before exposing the database.

## Environment Variables

See `.env.example` for full list. Key groups:

- Core: `DATABASE_URL`, `JWT_SECRET`, `PORT`
- Uploads (Cloudinary): `CLOUDINARY_*`
- Push (Firebase Admin): `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`
- Billing/Payments: `RAZORPAY_*`, `REDIS_URL`, `BILLING_CURRENT_CYCLE_CACHE_SEC`
- Super admin seed: `SUPER_ADMIN_*`

## Deploy Notes

Production sequence:

```bash
npm install
npm run build
npm run prisma:migrate:deploy
npm run start
```

If your DB provider occasionally times out on Prisma advisory locks (for example Neon on cold/wake), use:

```bash
npm run prisma:migrate:deploy:retry
```

This retries transient `P1002` advisory-lock failures before exiting.

### Error P3005 (database schema is not empty)

Prisma throws this when **`migrate dev`** runs against a database that already contains tables but has **no** (or incomplete) `_prisma_migrations` history — typical for an existing production/staging DB or when you pointed `.env` at a non-empty database.

**Do not use `migrate dev` on that database.** Fix it in one of these ways:

1. **Disposable local DB only** — Drop/recreate the database (or use a new empty Neon branch), then run `npm run prisma:migrate` again.

2. **Database already matches `prisma/schema.prisma`** (tables already created outside Migrate, or schema is fully up to date):

   - Confirm drift is empty:

     ```bash
     cd backend
     npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script
     ```

     If you only see an “empty migration” comment / no `CREATE` statements, you can baseline.

   - Record all migrations as applied **without** running SQL:

     ```bash
     npm run prisma:baseline
     ```

     Equivalent to `./scripts/baseline-existing-database.sh --yes` (requires `DATABASE_URL` in `.env` or environment).

3. **Database is missing objects** — Baseline alone will **not** create tables. Run `npm run prisma:migrate:deploy` (or `npm run prisma:migrate:deploy:retry`) so pending migrations apply; resolve duplicate-object errors manually if the DB was partially migrated.

After baselining, deploy updates with **`npm run prisma:migrate:deploy`** only — never `migrate dev` against production.

Make sure:

- `DATABASE_URL` points to production Postgres
- required secrets are set in your platform
- API is reachable over HTTPS by frontend/mobile

## API Overview

- Base path: `/api`
- Typical login routes:
  - `POST /api/auth/admin/login`
  - `POST /api/auth/super-admin/login`

For architecture and route grouping, see docs below.

## Documentation

- Development details: [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)
- Architecture: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- Feature map: [`docs/FEATURES.md`](./docs/FEATURES.md)
- Prisma CI/deploy: [`docs/PRISMA_CI.md`](./docs/PRISMA_CI.md)
- Maintenance billing mobile contract: [`docs/maintenance-billing-mobile-contract.md`](./docs/maintenance-billing-mobile-contract.md)
