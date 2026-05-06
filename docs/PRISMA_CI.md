# Prisma migrations in CI and production

## Apply migrations (recommended for deploy)

```bash
cd backend
npx prisma migrate deploy
```

This replays all SQL files under `prisma/migrations` that are not yet applied. Use this in CI/CD before starting the app when you rely on migration history.

## When the database and migration history disagree (drift)

Symptoms: `prisma migrate dev` reports drift, or `migrate deploy` fails.

**Options (pick one per environment):**

1. **Align dev DB with migrations** — Restore the DB from a backup that matches migrations, or reset a disposable database and run `migrate deploy`.
2. **Baseline an existing DB** — If the schema already matches `schema.prisma` but there is no migration history on that database, use Prisma’s [baselining](https://www.prisma.io/docs/guides/migrate/developing-with-prisma-migrate/baselining) workflow: mark historical migrations as applied without running them (`prisma migrate resolve`).
3. **Prototyping only** — `npx prisma db push` updates the database to match `schema.prisma` without creating migration files. It does **not** maintain a repeatable migration trail for CI; avoid for production unless your process explicitly allows it.

## Data safety (migrations must not wipe tables)

- **`prisma migrate deploy` does not erase rows by itself** — it only runs the SQL in each migration file. Routine migrations should use **CREATE**, **ALTER**, **INSERT** (seed data), etc.
- **Dangerous patterns** that delete all data from tables or remove tables entirely: **`DROP TABLE`**, **`TRUNCATE`**. Do not add these unless you intend data loss and have backups.
- Automated guard (optional in CI):

  ```bash
  cd backend && npm run verify:migrations-safe
  ```

  This fails if any `prisma/migrations/*/migration.sql` contains `DROP TABLE` or `TRUNCATE`, unless the migration folder name is listed in `scripts/migrations-safe-allowlist.json` after explicit review.

- **Other commands that destroy data** (not migrations): `prisma migrate reset`, `CONFIRM_DB_WIPE=1 npm run db:wipe-admin`, or truncating SQL run manually in Neon.

## CI checklist

- Run `prisma migrate deploy` (or your container entrypoint) against the target database URL before the Node process serves traffic.
- Optionally run `npm run verify:migrations-safe` so migrations never accidentally include `DROP TABLE` / `TRUNCATE` without an allowlist entry.
- Store `DATABASE_URL` as a secret; never commit credentials.
