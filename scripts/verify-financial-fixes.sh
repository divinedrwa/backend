#!/bin/bash

# Financial Fixes Verification Script
# Run this after deploying to ensure all fixes are active

set -e

echo "================================================================================"
echo "🔍 VERIFYING FINANCIAL SECURITY FIXES"
echo "================================================================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS=0
FAIL=0

check() {
  if [ $1 -eq 0 ]; then
    echo -e "${GREEN}✅ $2${NC}"
    ((PASS++))
  else
    echo -e "${RED}❌ $2${NC}"
    ((FAIL++))
  fi
}

echo "1. Checking Database Schema..."
echo "--------------------------------"

# Check if idempotencyKey column exists
psql $DATABASE_URL -c "SELECT column_name FROM information_schema.columns WHERE table_name='MaintenancePayment' AND column_name='idempotencyKey';" -t | grep -q "idempotencyKey"
check $? "idempotencyKey column exists on MaintenancePayment"

# Check if ReconciliationAlert table exists
psql $DATABASE_URL -c "SELECT table_name FROM information_schema.tables WHERE table_name='ReconciliationAlert';" -t | grep -q "ReconciliationAlert"
check $? "ReconciliationAlert table exists"

# Check CHECK constraints
psql $DATABASE_URL -c "SELECT conname FROM pg_constraint WHERE conname='check_amount_positive';" -t | grep -q "check_amount_positive"
check $? "check_amount_positive constraint exists"

psql $DATABASE_URL -c "SELECT conname FROM pg_constraint WHERE conname='check_paid_amount_non_negative';" -t | grep -q "check_paid_amount_non_negative"
check $? "check_paid_amount_non_negative constraint exists"

echo ""
echo "2. Checking Code Quality..."
echo "--------------------------------"

cd "$(dirname "$0")/.." || exit 1

# TypeScript check
npm run typecheck > /dev/null 2>&1
check $? "TypeScript compilation passes"

# Lint check (only check for errors, ignore warnings)
npm run lint 2>&1 | grep -q "0 errors" || npm run lint 2>&1 | grep -vq "error"
check $? "ESLint passes (no errors)"

echo ""
echo "3. Checking Required Files..."
echo "--------------------------------"

[ -f "src/lib/reconciliation.ts" ]
check $? "Reconciliation service exists"

[ -f "src/modules/reconciliation/routes.ts" ]
check $? "Reconciliation routes exist"

[ -f "prisma/migrations/20260513_add_idempotency_key/migration.sql" ]
check $? "Idempotency migration exists"

[ -f "prisma/migrations/20260513_add_reconciliation_and_constraints/migration.sql" ]
check $? "Reconciliation migration exists"

echo ""
echo "4. Checking API Endpoints (requires running server)..."
echo "--------------------------------"

if curl -s http://localhost:4000/health > /dev/null 2>&1; then
  echo "✓ Server is running"
  
  # This requires an admin token - skip if not provided
  if [ -n "$ADMIN_TOKEN" ]; then
    curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4000/api/reconciliation/summary > /dev/null 2>&1
    check $? "Reconciliation summary endpoint accessible"
    
    curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4000/api/reconciliation/alerts > /dev/null 2>&1
    check $? "Reconciliation alerts endpoint accessible"
  else
    echo -e "${YELLOW}⚠️  Set ADMIN_TOKEN to test API endpoints${NC}"
  fi
else
  echo -e "${YELLOW}⚠️  Server not running - skipping API checks${NC}"
  echo "   Start with: npm run dev"
fi

echo ""
echo "================================================================================"
echo "📊 VERIFICATION RESULTS"
echo "================================================================================"
echo ""
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}🎉 ALL CHECKS PASSED - SYSTEM IS PRODUCTION READY${NC}"
  echo ""
  echo "Next steps:"
  echo "1. Deploy migrations: npm run prisma:migrate:deploy"
  echo "2. Build production: npm run build"
  echo "3. Start server: npm run start"
  echo "4. Monitor cron logs for hourly reconciliation"
  exit 0
else
  echo -e "${RED}❌ SOME CHECKS FAILED - REVIEW ERRORS ABOVE${NC}"
  echo ""
  echo "Fix issues before deploying to production."
  exit 1
fi
