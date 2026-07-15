#!/usr/bin/env bash
# Clone live Supabase (backend/.env DIRECT_URL) into local Postgres (backend/.env.local).
#
# - READ-ONLY on remote (pg_dump)
# - DESTRUCTIVE on local (drops and recreates gatepass_local)
#
# Usage (from backend/):
#   CONFIRM_DB_CLONE=1 npm run db:clone-from-live
#
# Optional:
#   KEEP_DUMP=1          — retain dump file under .local-db-dumps/
#   SKIP_DEV_KILL=1      — do not kill port 4000 before clone

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${CONFIRM_DB_CLONE:-}" != "1" ]]; then
  echo "❌ Refusing to run without CONFIRM_DB_CLONE=1"
  echo ""
  echo "This will:"
  echo "  1. pg_dump the LIVE Supabase database (read-only)"
  echo "  2. DROP and recreate your LOCAL database from backend/.env.local"
  echo "  3. pg_restore the full public schema + data into local"
  echo ""
  echo "Run:"
  echo "  CONFIRM_DB_CLONE=1 npm run db:clone-from-live"
  exit 1
fi

for cmd in psql dropdb createdb; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "❌ Missing required command: $cmd (install PostgreSQL client tools)"
    exit 1
  fi
done

resolve_pg_tool() {
  local tool="$1"
  local candidate chosen=""
  local candidates=(
    "/usr/local/opt/postgresql@18/bin/$tool"
    "/opt/homebrew/opt/postgresql@18/bin/$tool"
    "/usr/local/opt/postgresql@17/bin/$tool"
    "/opt/homebrew/opt/postgresql@17/bin/$tool"
    "/usr/local/opt/postgresql@16/bin/$tool"
    "/opt/homebrew/opt/postgresql@16/bin/$tool"
    "$(command -v "$tool" 2>/dev/null || true)"
  )
  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    chosen="$candidate"
    break
  done
  if [[ -z "$chosen" ]]; then
    echo "❌ Missing required command: $tool (install PostgreSQL 17+ client tools)"
    exit 1
  fi
  echo "$chosen"
}

PG_DUMP="$(resolve_pg_tool pg_dump)"
PG_RESTORE="$(resolve_pg_tool pg_restore)"
echo "Using: $($PG_DUMP --version)"

read_env_urls() {
  node -e "
    const path = require('path');
    const dotenv = require('dotenv');
    dotenv.config({ path: '.env' });
    const local = {};
    dotenv.config({ path: path.resolve('.env.local'), processEnv: local, override: true });
    const remote = process.env.DIRECT_URL || process.env.DATABASE_URL;
    const localUrl = local.DATABASE_URL;
    if (!remote) {
      console.error('❌ DIRECT_URL (or DATABASE_URL) missing in backend/.env');
      process.exit(1);
    }
    if (!localUrl) {
      console.error('❌ DATABASE_URL missing in backend/.env.local');
      process.exit(1);
    }
    const lower = localUrl.toLowerCase();
    const localOk =
      lower.includes('127.0.0.1') ||
      lower.includes('localhost') ||
      lower.includes('::1');
    if (!localOk || lower.includes('supabase')) {
      console.error('❌ backend/.env.local must point at local Postgres, not Supabase/remote');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ remote, local: localUrl }));
  "
}

URLS_JSON="$(read_env_urls)"
REMOTE_URL="$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.remote)" "$URLS_JSON")"
LOCAL_URL="$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.local)" "$URLS_JSON")"

parse_db_name() {
  node -e "
    const u = new URL(process.argv[1]);
    const name = (u.pathname || '/postgres').replace(/^\\//, '') || 'postgres';
    console.log(name);
  " "$1"
}

LOCAL_DB="$(parse_db_name "$LOCAL_URL")"

echo "=== Clone live Supabase → local Postgres ==="
echo "Remote: (from backend/.env DIRECT_URL)"
echo "Local:  ${LOCAL_DB} on 127.0.0.1"
echo ""

if [[ "${SKIP_DEV_KILL:-}" != "1" ]]; then
  if [[ -f ../scripts/dev-kill-ports.sh ]]; then
    echo "Stopping local API on :4000 (frees DB connections)…"
    bash ../scripts/dev-kill-ports.sh || true
  fi
fi

DUMP_DIR=".local-db-dumps"
mkdir -p "$DUMP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
DUMP_FILE="${DUMP_DIR}/live_supabase_${STAMP}.dump"

echo "Dumping live database (public schema)…"
"$PG_DUMP" "$REMOTE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --schema=public \
  --verbose \
  --file="$DUMP_FILE"

echo ""
echo "Recreating local database '${LOCAL_DB}'…"
psql "$(node -e "
  const u = new URL(process.argv[1]);
  u.pathname = '/postgres';
  console.log(u.toString());
" "$LOCAL_URL")" -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '${LOCAL_DB}' AND pid <> pg_backend_pid();
SQL

dropdb --if-exists "$LOCAL_DB" 2>/dev/null || true
createdb "$LOCAL_DB"

echo "Restoring into local '${LOCAL_DB}'…"
set +e
"$PG_RESTORE" \
  --no-owner \
  --no-acl \
  --dbname="$LOCAL_URL" \
  --verbose \
  "$DUMP_FILE"
RESTORE_EXIT=$?
set -e
if [[ "$RESTORE_EXIT" -ne 0 ]]; then
  echo "⚠️  pg_restore exited with code ${RESTORE_EXIT} (often PG version SET/schema noise — verifying data next)…"
fi

echo ""
echo "Verifying row counts (sample)…"
psql "$LOCAL_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'Society' AS entity, COUNT(*)::text AS rows FROM "Society"
UNION ALL SELECT 'User', COUNT(*)::text FROM "User"
UNION ALL SELECT '_prisma_migrations', COUNT(*)::text FROM "_prisma_migrations";
SQL

echo ""
echo "Applying repo migrations on local (live may lag behind schema.prisma)…"
set +e
MIGRATE_OUT="$(npm run prisma:migrate:local 2>&1)"
MIGRATE_EXIT=$?
set -e
echo "$MIGRATE_OUT"
if [[ "$MIGRATE_EXIT" -ne 0 ]]; then
  if echo "$MIGRATE_OUT" | grep -q "already exists"; then
    FAILED="$(echo "$MIGRATE_OUT" | sed -n 's/.*Migration name: \(.*\)/\1/p' | head -1)"
    if [[ -n "$FAILED" ]]; then
      echo "Marking already-present migration as applied: $FAILED"
      npx tsx scripts/prisma-with-local-env.ts migrate resolve --applied "$FAILED"
      npm run prisma:migrate:local
    fi
  else
    echo "❌ prisma:migrate:local failed — fix manually"
    exit 1
  fi
fi

echo ""
echo "Checking schema drift vs prisma/schema.prisma…"
set +e
DRIFT="$(npx prisma migrate diff \
  --from-url "$LOCAL_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script 2>/dev/null)"
set -e
if [[ -n "$(echo "$DRIFT" | tr -d '[:space:]')" ]]; then
  echo "⚠️  Remaining drift after migrate deploy:"
  echo "$DRIFT" | head -40
else
  echo "✓ Local schema matches prisma/schema.prisma"
fi

if [[ "${KEEP_DUMP:-}" != "1" ]]; then
  rm -f "$DUMP_FILE"
  echo "Removed dump file (set KEEP_DUMP=1 to retain)."
else
  echo "Dump kept at: $DUMP_FILE"
fi

echo ""
echo "✅ Local database is now a replica of live Supabase (public schema)."
echo "   Restart stack: backend/.env.local overrides .env — API uses local DB."
echo "   Frontend should use: NEXT_PUBLIC_API_URL=http://localhost:4000/api"
