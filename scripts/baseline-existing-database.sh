#!/usr/bin/env bash
# Baseline a non-empty database that was never tracked by Prisma Migrate (P3005 / "schema is not empty").
#
# Use ONLY when the live database already matches prisma/schema.prisma (all tables/columns from
# your migrations are already there). This records every migration in _prisma_migrations without
# re-running SQL.
#
# 1) Verify no drift (output should be "empty" / no statements):
#    cd backend && npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script
#
# 2) Mark all local migrations as applied:
#    cd backend && ./scripts/baseline-existing-database.sh --yes
#
# 3) After that, always use: npx prisma migrate deploy
#
# Do NOT baseline if the DB is missing objects — run `npx prisma migrate deploy` first on a
# copy, or apply missing SQL, then baseline only if you had to hand-fix history.

set -euo pipefail
cd "$(dirname "$0")/.."

# Do not `source` .env: values with spaces (e.g. SOCIETY_NAME=Super Admin Society) break the shell.
# Load only DB URLs the same way Node/Prisma do (dotenv).
if [[ -f .env ]]; then
  eval "$(
    node -e "
      require('dotenv').config({ path: '.env' });
      const out = (k) => {
        const v = process.env[k];
        if (v != null && v !== '') {
          process.stdout.write('export ' + k + '=' + JSON.stringify(v) + '\n');
        }
      };
      out('DATABASE_URL');
      out('DIRECT_URL');
    "
  )"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Error: DATABASE_URL is not set (e.g. export it or add it to backend/.env)."
  exit 1
fi

if [[ "${1:-}" != "--yes" ]]; then
  echo "This will run: prisma migrate resolve --applied <name> for every folder under prisma/migrations."
  echo "Re-run with:  ./scripts/baseline-existing-database.sh --yes"
  exit 1
fi

shopt -s nullglob
dirs=(prisma/migrations/2*/)
if [[ ${#dirs[@]} -eq 0 ]]; then
  echo "No migration directories found under prisma/migrations."
  exit 1
fi

for dir in "${dirs[@]}"; do
  name=$(basename "$dir")
  echo "Marking applied: $name"
  npx prisma migrate resolve --applied "$name"
done

echo "Done. Use 'npx prisma migrate deploy' for future updates (not migrate dev on production)."
