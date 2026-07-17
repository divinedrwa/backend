#!/usr/bin/env bash
# K5 live production sign-off — read-only on live API.
set -euo pipefail

BACKEND="$(cd "$(dirname "$0")/.." && pwd)"
MONO="$(cd "$BACKEND/.." && pwd)"
# shellcheck disable=SC1091
source "$BACKEND/scripts/live-env.sh"

REPORT="${K5_REPORT_PATH:-$BACKEND/docs/LIVE_RELEASE_REPORT.md}"
DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
VERSION="${RELEASE_VERSION:-live-$(date +%Y%m%d)}"
RESULTS_FILE="$(mktemp)"

if [[ -f "$BACKEND/.env.smoke" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$BACKEND/.env.smoke"
  set +a
fi

export MOBILE_SMOKE_READ_ONLY=1
export LIVE_SMOKE_SAFE=1
export HTTP_SMOKE_READ_ONLY=1

failures=0
record() { printf '%s\t%s\n' "$1" "$2" >> "$RESULTS_FILE"; }
run_step() {
  local label="$1"; shift
  echo ""; echo "=== $label ==="
  if "$@"; then record "$label" "PASS"; else record "$label" "FAIL"; failures=$((failures + 1)); fi
}
status_of() { awk -F '\t' -v k="$1" '$1 == k { print $2; exit }' "$RESULTS_FILE" 2>/dev/null || true; }
mark() { [[ "$(status_of "$1")" == "PASS" ]] && echo "✅" || echo "❌"; }

echo "=== K5 live gate ==="
echo "API: ${LIVE_API_ORIGIN}"

cd "$BACKEND"
run_step "prisma:generate" npm run prisma:generate
run_step "typecheck" npm run typecheck
run_step "unit tests" npm test
run_step "verify:mobile-api-manifest" npm run verify:mobile-api-manifest
run_step "test:payments" npm run test:payments
run_step "test:finance" npm run test:finance
run_step "live villa25 safe" npm run smoke:live:villa25
run_step "live smoke read-only" bash "$BACKEND/scripts/smoke-live-target.sh"

if [[ -d "$MONO/divine_app" ]]; then
  run_step "flutter C3" bash -c "cd '$MONO/divine_app' && flutter test test/features/resident/maintenance/payment_journey_test.dart test/integration/payment_journey_orchestrator_test.dart"
else
  record "flutter C3" "SKIP"
  echo ""; echo "=== flutter C3 ==="; echo "  ○ skip (divine_app not sibling of backend/)"
fi

mkdir -p "$(dirname "$REPORT")"
cat > "$REPORT" <<EOF
# Live release report (K5)

- **Version:** $VERSION
- **Generated:** $DATE
- **API:** ${LIVE_API_ORIGIN}
- **Policy:** Read-only live smokes

| Gate | Result |
|------|--------|
| unit tests | $(mark "unit tests") |
| verify:mobile-api-manifest | $(mark "verify:mobile-api-manifest") |
| test:payments | $(mark "test:payments") |
| test:finance | $(mark "test:finance") |
| villa-25 safe smoke | $(mark "live villa25 safe") |
| live smoke read-only | $(mark "live smoke read-only") |
| Flutter C3 | $(mark "flutter C3") |

Regenerate: \`npm run k5:live\`
EOF

rm -f "$RESULTS_FILE"
echo ""; echo "Wrote $REPORT"
[[ "$failures" -gt 0 ]] && { echo "K5 live gate: $failures FAILED"; exit 1; }
echo "K5 live gate PASSED."
