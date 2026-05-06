# Architecture

## High level

```text
┌─────────────┐     ┌─────────────┐
│  frontend   │     │ divine_app  │
│  (Next.js)  │     │  (Flutter)  │
└──────┬──────┘     └──────┬──────┘
       │                   │
       └─────────┬─────────┘
                 │  HTTPS / HTTP
                 ▼
         ┌───────────────┐
         │    backend    │
         │ Express /api  │
         └───────┬───────┘
                 │
                 ▼
         ┌───────────────┐
         │  PostgreSQL   │
         │    (Prisma)   │
         └───────────────┘
```

- **Multi-society:** Data is scoped by `societyId` (and related tenant keys) in Prisma models.
- **Roles:** `ADMIN`, `RESIDENT`, `GUARD` — enforced in middleware per route module.

## Backend layout

| Area | Path | Notes |
|------|------|--------|
| Entry | `src/server.ts`, `src/app.ts` | `/api` router, `/health`, `/uploads` static, JSON body, CORS, global Zod error handler |
| Routes registry | `src/routes/index.ts` | Mounts all feature routers |
| Features | `src/modules/*` | Each domain: routes + Prisma + Zod schemas where used |

### Major route prefixes (under `/api`)

- **Auth & directory:** `/auth`, `/users`, `/villas`, `/resident-management`
- **Money / ops:** `/maintenance`, `/maintenance-bills`, `/maintenance-management`, `/bank-accounts`, `/expenses`, …
- **Operations:** `/complaints`, `/complaint-analytics`, `/vendors`, `/notices`, `/gates`, `/gate-analytics`, `/guard-shifts`, `/guard-patrols`
- **Residents & assets:** `/visitors`, `/pre-approved-visitors`, `/parcels`, `/amenities`, `/amenity-bookings`, `/staff`, `/vehicles`, `/parking-management`, `/polls`, `/documents`, `/incidents`, `/banners`, `/notifications`
- **Emergency / facility:** `/sos-alerts`, `/water-supply`, `/garbage-collection`, …

### Mobile-focused mounts (same Express app)

- **`/residents/*`** — Resident profile, dashboard, maintenance, visitors (including pre-approve), parcels, complaints, amenities, vehicles, staff, etc. Multiple router files are merged under `/residents`.
- **`/guards/*`** — Guard dashboard, visitor check-in/out, parcels, patrols, incidents.

Exact handlers live in `src/modules/residents/` and `src/modules/guards/` (and related).

## Database

- **Schema:** `backend/prisma/schema.prisma` — PostgreSQL, large model set (society, users, villas, maintenance, visitors, parcels, amenities, notifications, …).
- **Migrations:** `backend/prisma/migrations/`
- **Seed:** `npm run prisma:seed` from `backend/`

## Admin frontend

- **Next.js App Router:** `frontend/src/app/`
- **API helper:** `frontend/src/lib/api.ts` — `NEXT_PUBLIC_API_URL` base (default `http://localhost:4000/api`), JWT from `localStorage`

## API response patterns

Many list endpoints return wrapped JSON, for example:

```json
{
  "items": [],
  "count": 0
}
```

Exact keys vary (`visitors`, `preApproved`, `summary`, etc.). Mobile repositories in Flutter map these keys per feature. Zod validation errors return HTTP 400 with:

```json
{
  "message": "Validation failed",
  "issues": [{ "path": ["field"], "message": "..." }]
}
```

Clients should surface `issues` for usable field-level messages.

## Security notes

- JWT in `Authorization: Bearer …`
- Passwords hashed (bcrypt); never log tokens in production builds

## Related

- **Backend setup:** [DEVELOPMENT.md](./DEVELOPMENT.md)
- **Monorepo README:** [../../README.md](../../README.md)
