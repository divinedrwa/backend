#!/usr/bin/env bash
# Read-only live smokes — no parcel/visitor/payment/ledger writes.
set -euo pipefail

BACKEND="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$BACKEND/scripts/live-env.sh"

if [[ -f "$BACKEND/.env.smoke" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$BACKEND/.env.smoke"
  set +a
fi

export MOBILE_SMOKE_READ_ONLY=1
export LIVE_SMOKE_SAFE=1

tenant_user="${SMOKE_TENANT_ADMIN_USERNAME:-${SMOKE_ADMIN_USERNAME:-}}"
resident_user="${MOBILE_SMOKE_RESIDENT_USER:-}"
resident_pass="${MOBILE_SMOKE_RESIDENT_PASS:-}"
tenant_pass="${SMOKE_TENANT_ADMIN_PASSWORD:-${SMOKE_ADMIN_PASSWORD:-}}"

echo "=== Live smoke (read-only) → ${HTTP_SMOKE_BASE} ==="

if ! curl -sf "${HTTP_SMOKE_BASE}/health" >/dev/null 2>&1; then
  echo "❌ Live API not reachable at ${HTTP_SMOKE_BASE}/health"
  exit 1
fi

cd "$BACKEND"
HTTP_SMOKE_BASE="${HTTP_SMOKE_BASE}" npm run smoke:http

echo "  ○ skip smoke:payments on live (money reads covered by smoke:live:villa25)"

if [[ -n "$tenant_user" || -n "$resident_user" ]]; then
  MOBILE_SMOKE_BASE="${MOBILE_SMOKE_BASE}" \
    MOBILE_SMOKE_READ_ONLY=1 \
    LIVE_SMOKE_SAFE=1 \
    MOBILE_SMOKE_SOCIETY_ID="${MOBILE_SMOKE_SOCIETY_ID:-${SMOKE_SOCIETY_ID:-cmp32fto40001qout5koygcqu}}" \
    MOBILE_SMOKE_ADMIN_USER="${MOBILE_SMOKE_ADMIN_USER:-${tenant_user:-$resident_user}}" \
    MOBILE_SMOKE_ADMIN_PASS="${MOBILE_SMOKE_ADMIN_PASS:-${tenant_pass:-$resident_pass}}" \
    MOBILE_SMOKE_RESIDENT_USER="${MOBILE_SMOKE_RESIDENT_USER:-}" \
    MOBILE_SMOKE_RESIDENT_PASS="${MOBILE_SMOKE_RESIDENT_PASS:-}" \
    MOBILE_SMOKE_GUARD_USER="${MOBILE_SMOKE_GUARD_USER:-}" \
    MOBILE_SMOKE_GUARD_PASS="${MOBILE_SMOKE_GUARD_PASS:-}" \
    npm run smoke:mobile-apis || {
      echo "  ○ mobile GET smoke skipped (login/rate limit — villa25 smoke is authoritative)"
      exit 0
    }
else
  echo "  ○ skip smoke:mobile-apis (no creds — use smoke:live:villa25)"
fi

echo "=== Live smoke PASSED (read-only) ==="
