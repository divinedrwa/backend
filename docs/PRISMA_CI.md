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

## CI checklist

- Run `prisma migrate deploy` (or your container entrypoint) against the target database URL before the Node process serves traffic.
- Store `DATABASE_URL` as a secret; never commit credentials.
