# Backend & database — development

## Prerequisites

- **Node.js** 18+
- **PostgreSQL** (local or hosted, e.g. Neon)

## Database

### Local (example: macOS)

```bash
brew install postgresql@15
brew services start postgresql@15
createdb society_admin
```

### Cloud

Create a project at [neon.tech](https://neon.tech) and copy the connection string into `DATABASE_URL` in `backend/.env`.

## Backend (`backend/`)

```bash
cd backend
npm install
cp .env.example .env
# Edit .env:
#   DATABASE_URL="postgresql://USER:PASS@HOST:5432/DBNAME"
#   JWT_SECRET="long-random-string"
#   PORT=4000 (optional)

npm run prisma:generate
npm run prisma:migrate   # or: npx prisma migrate dev --name init
npm run prisma:seed      # minimal: one society + admin drwa@divine.com / Divine@123 (see below)
npm run dev              # listens on 0.0.0.0:PORT — reachable from LAN for physical devices
```

- **Health:** `curl http://localhost:4000/health` → `{"ok":true}`
- **Static uploads:** profile images served from `/uploads/...` relative to API origin.

### Login testing (seed)

**Default seed (`npm run prisma:seed`)** creates one society and a single admin:

- Email: `drwa@divine.com`
- Username: `drwa`
- Password: `Divine@123`

Override at seed time: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_USERNAME`, `SOCIETY_NAME`.

**Super admin** (optional): set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` in `.env`, then run `npm run prisma:seed`. See `.env.example`.

**Wipe all data and recreate only that admin** (destructive):

```bash
cd backend
CONFIRM_DB_WIPE=1 npm run db:wipe-admin
```

**Demo dataset** (guards, residents, villas, bills): `npm run prisma:seed-demo`. Useful for manual mobile checks with users like `guard1` / `resident1`.

## Prisma in CI / production

See [PRISMA_CI.md](./PRISMA_CI.md).

## Optional: Firebase (push notifications)

The Flutter app runs **without** Firebase; push is disabled until configured.

1. Create a Firebase project → add Android + iOS apps with the **same package/bundle IDs** as the Flutter `android/app/build.gradle.kts` and `ios` Runner.
2. Download **`google-services.json`** → `divine_app/android/app/`
3. Download **`GoogleService-Info.plist`** → `divine_app/ios/Runner/`
4. Android: apply Google Services plugin per Firebase docs (`google-services` classpath + app plugin).
5. **Backend:** set Firebase Admin credentials in `backend/.env` if the API sends FCM messages (see Firebase Admin SDK docs).
6. Rebuild the mobile app.

## Troubleshooting

| Issue | Hint |
|-------|------|
| Prisma migrate fails | Check `DATABASE_URL`, Postgres running, user has DDL rights |
| Mobile cannot reach API | Same Wi‑Fi, API on `0.0.0.0`, correct LAN IP on device or `API_HOST` dart-define, macOS firewall |
| Zod `Validation failed` on mobile | Backend returns `issues[]`; client should show field messages; datetime fields often need ISO strings with timezone (`Z`) |

## Other apps in this monorepo

- **Admin web:** [../../frontend/docs/DEVELOPMENT.md](../../frontend/docs/DEVELOPMENT.md)
- **Flutter:** [../../divine_app/docs/DEVELOPMENT.md](../../divine_app/docs/DEVELOPMENT.md)
- **Monorepo index:** [../../DEVELOPMENT.md](../../DEVELOPMENT.md)
