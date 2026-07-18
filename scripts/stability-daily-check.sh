#!/usr/bin/env bash
# Daily §10.4 stability check (~2 min). Run from backend/: npm run stability:daily
set -euo pipefail

BACKEND="$(cd "$(dirname "$0")/.." && pwd)"
API="${LIVE_API_ORIGIN:-https://gatepass-v037.onrender.com}"
DATE="$(date +%Y-%m-%d)"
FAIL=0

echo "=== Stability daily — $DATE ==="
echo "API: $API"

if curl -sf "$API/health" | grep -q '"ok":true'; then
  echo "✅ API health"
else
  echo "❌ API health failed"
  FAIL=1
fi

if curl -sf -o /dev/null -w "" "$API/api/payment-disputes" || [[ "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/payment-disputes")" == "401" ]]; then
  echo "✅ API routes responding (401 unauth expected)"
else
  echo "❌ API routes unexpected"
  FAIL=1
fi

if [[ -f "$BACKEND/.env.smoke" ]]; then
  if (cd "$BACKEND" && npm run smoke:live:villa25 >/dev/null 2>&1); then
    echo "✅ Villa 25 live read smoke"
  else
    echo "❌ Villa 25 live read smoke failed (run: npm run smoke:live:villa25)"
    FAIL=1
  fi
else
  echo "○ skip villa25 (no .env.smoke)"
fi

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "Day $DATE: GREEN — log in docs/STABILITY_30_DAY_TRACKER.md"
  exit 0
fi
echo "Day $DATE: RED — streak resets; fix before next day"
exit 1
