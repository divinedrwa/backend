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
npm run prisma:migrate
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
- `npm run prisma:migrate` - apply dev migrations
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

Optional super admin can be upserted on seed if these are set:

- `SUPER_ADMIN_EMAIL`
- `SUPER_ADMIN_PASSWORD`
- (optional) `SUPER_ADMIN_USERNAME` (default `super_admin`)
- (optional) `SUPER_ADMIN_NAME`

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
npx prisma migrate deploy
npm run start
```

If your DB provider occasionally times out on Prisma advisory locks (for example Neon on cold/wake), use:

```bash
npm run prisma:migrate:deploy:retry
```

This retries transient `P1002` advisory-lock failures before exiting.

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
