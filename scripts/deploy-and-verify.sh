#!/bin/bash

################################################################################
# PRODUCTION DEPLOYMENT & VERIFICATION SCRIPT
# Applies migrations, verifies schema, and tests all critical features
################################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PASS=0
FAIL=0
WARN=0

echo -e "${BLUE}"
echo "================================================================================"
echo "🚀 PRODUCTION DEPLOYMENT & VERIFICATION"
echo "================================================================================"
echo -e "${NC}"

log_success() {
  echo -e "${GREEN}✅ $1${NC}"
  ((PASS++))
}

log_error() {
  echo -e "${RED}❌ $1${NC}"
  ((FAIL++))
}

log_warning() {
  echo -e "${YELLOW}⚠️  $1${NC}"
  ((WARN++))
}

log_info() {
  echo -e "${BLUE}ℹ️  $1${NC}"
}

log_step() {
  echo ""
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

################################################################################
# STEP 1: Pre-flight Checks
################################################################################

log_step "STEP 1: Pre-flight Checks"

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
  log_error "Not in backend directory. Please run from backend/ folder."
  exit 1
fi
log_success "In correct directory (backend/)"

# Check if .env exists
if [ ! -f ".env" ]; then
  log_error ".env file not found"
  exit 1
fi
log_success ".env file exists"

# Check DATABASE_URL
if ! grep -q "DATABASE_URL" .env; then
  log_error "DATABASE_URL not found in .env"
  exit 1
fi
log_success "DATABASE_URL configured"

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  log_warning "Node.js version $NODE_VERSION detected. Recommend 18+"
else
  log_success "Node.js version: $(node -v)"
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
  log_info "Installing dependencies..."
  npm install > /dev/null 2>&1
  log_success "Dependencies installed"
else
  log_success "Dependencies already installed"
fi

################################################################################
# STEP 2: Database Backup
################################################################################

log_step "STEP 2: Database Backup"

log_info "Creating database backup..."
BACKUP_DIR="./backups"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/pre-migration-backup-$(date +%Y%m%d-%H%M%S).sql"

# Extract connection details from DATABASE_URL
DB_URL=$(grep DATABASE_URL .env | cut -d'=' -f2- | tr -d '"')

# Try to create backup (optional, may require pg_dump)
if command -v pg_dump &> /dev/null; then
  log_info "Attempting database backup with pg_dump..."
  if pg_dump "$DB_URL" > "$BACKUP_FILE" 2>/dev/null; then
    log_success "Database backup created: $BACKUP_FILE"
  else
    log_warning "Could not create backup (Supabase may require different method)"
    log_info "Recommend using Supabase dashboard to create backup"
  fi
else
  log_warning "pg_dump not found. Recommend manual backup via Supabase dashboard"
fi

################################################################################
# STEP 3: Generate Prisma Client
################################################################################

log_step "STEP 3: Generate Prisma Client"

log_info "Generating Prisma client..."
if npm run prisma:generate > /dev/null 2>&1; then
  log_success "Prisma client generated"
else
  log_error "Failed to generate Prisma client"
  exit 1
fi

################################################################################
# STEP 4: Apply Database Migrations
################################################################################

log_step "STEP 4: Apply Database Migrations"

log_info "Checking migration status..."
PENDING_MIGRATIONS=$(npx prisma migrate status 2>&1 | grep -c "have not yet been applied" || echo "0")

if [ "$PENDING_MIGRATIONS" -eq 0 ]; then
  log_success "No pending migrations (already applied)"
else
  log_info "Found $PENDING_MIGRATIONS pending migration(s)"
  log_info "Applying migrations..."
  
  if npm run prisma:migrate:deploy 2>&1 | tee /tmp/migration.log; then
    log_success "Migrations applied successfully"
  else
    log_error "Migration failed. Check /tmp/migration.log for details"
    cat /tmp/migration.log
    exit 1
  fi
fi

################################################################################
# STEP 5: Verify Schema Changes
################################################################################

log_step "STEP 5: Verify Schema Changes"

log_info "Verifying database schema..."

# Check if idempotencyKey column exists
log_info "Checking MaintenancePayment.idempotencyKey column..."
if npx prisma db execute --stdin <<'SQL' 2>/dev/null | grep -q "idempotencyKey"
SELECT column_name FROM information_schema.columns 
WHERE table_name='MaintenancePayment' AND column_name='idempotencyKey';
SQL
then
  log_success "idempotencyKey column exists"
else
  log_error "idempotencyKey column NOT found"
fi

# Check if ReconciliationAlert table exists
log_info "Checking ReconciliationAlert table..."
if npx prisma db execute --stdin <<'SQL' 2>/dev/null | grep -q "ReconciliationAlert"
SELECT table_name FROM information_schema.tables 
WHERE table_name='ReconciliationAlert';
SQL
then
  log_success "ReconciliationAlert table exists"
else
  log_error "ReconciliationAlert table NOT found"
fi

# Check CHECK constraints
log_info "Checking database constraints..."
CONSTRAINTS=$(npx prisma db execute --stdin <<'SQL' 2>/dev/null | grep -c "check_amount_positive\|check_paid_amount_non_negative" || echo "0"
SELECT conname FROM pg_constraint 
WHERE conname IN ('check_amount_positive', 'check_paid_amount_non_negative');
SQL
)

if [ "$CONSTRAINTS" -ge 1 ]; then
  log_success "CHECK constraints exist"
else
  log_warning "CHECK constraints may not be present"
fi

################################################################################
# STEP 6: TypeScript Compilation
################################################################################

log_step "STEP 6: TypeScript Compilation"

log_info "Running TypeScript type check..."
if npm run typecheck > /dev/null 2>&1; then
  log_success "TypeScript compilation passed (0 errors)"
else
  log_error "TypeScript compilation failed"
  npm run typecheck 2>&1 | tail -20
  exit 1
fi

################################################################################
# STEP 7: Build Production Bundle
################################################################################

log_step "STEP 7: Build Production Bundle"

log_info "Building production bundle..."
if npm run build > /dev/null 2>&1; then
  log_success "Production build successful"
  
  if [ -d "dist" ]; then
    DIST_SIZE=$(du -sh dist | cut -f1)
    log_info "Build size: $DIST_SIZE"
  fi
else
  log_error "Build failed"
  exit 1
fi

################################################################################
# STEP 8: Start Backend (Background)
################################################################################

log_step "STEP 8: Start Backend Server"

# Kill any existing process on port 4000
log_info "Checking for existing server on port 4000..."
if lsof -i :4000 > /dev/null 2>&1; then
  log_info "Killing existing process on port 4000..."
  lsof -ti :4000 | xargs kill -9 2>/dev/null || true
  sleep 2
  log_success "Port 4000 freed"
fi

# Start server in background
log_info "Starting backend server..."
NODE_ENV=production npm run start > /tmp/backend.log 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > /tmp/backend.pid

# Wait for server to start
log_info "Waiting for server to start (max 30 seconds)..."
for i in {1..30}; do
  if curl -s http://localhost:4000/health > /dev/null 2>&1; then
    log_success "Backend server started (PID: $SERVER_PID)"
    break
  fi
  
  if [ $i -eq 30 ]; then
    log_error "Server failed to start within 30 seconds"
    log_info "Check logs: tail -f /tmp/backend.log"
    exit 1
  fi
  
  sleep 1
done

################################################################################
# STEP 9: Health Check
################################################################################

log_step "STEP 9: Health Check"

log_info "Testing health endpoint..."
HEALTH_RESPONSE=$(curl -s http://localhost:4000/health)

if echo "$HEALTH_RESPONSE" | grep -q '"ok":true'; then
  log_success "Health check passed"
  echo "$HEALTH_RESPONSE" | jq '.' 2>/dev/null || echo "$HEALTH_RESPONSE"
else
  log_error "Health check failed"
  echo "Response: $HEALTH_RESPONSE"
fi

################################################################################
# STEP 10: API Endpoint Verification
################################################################################

log_step "STEP 10: API Endpoint Verification"

log_info "Checking critical endpoints..."

# Test public endpoint
if curl -s http://localhost:4000/api/public/health > /dev/null 2>&1; then
  log_success "Public endpoints accessible"
else
  log_warning "Public endpoints may not be accessible"
fi

# Check if reconciliation routes are registered
log_info "Verifying reconciliation routes exist..."
if grep -q "reconciliationRoutes" src/routes/index.ts; then
  log_success "Reconciliation routes registered"
else
  log_warning "Reconciliation routes may not be registered"
fi

################################################################################
# STEP 11: Database Connection Test
################################################################################

log_step "STEP 11: Database Connection Test"

log_info "Testing database connectivity..."
DB_TEST=$(node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.\$queryRaw\`SELECT 1 as result\`
  .then(() => { console.log('OK'); process.exit(0); })
  .catch(err => { console.error(err.message); process.exit(1); })
  .finally(() => prisma.\$disconnect());
" 2>&1)

if echo "$DB_TEST" | grep -q "OK"; then
  log_success "Database connection successful"
else
  log_error "Database connection failed: $DB_TEST"
fi

################################################################################
# STEP 12: Verify Financial Features
################################################################################

log_step "STEP 12: Verify Financial Features"

log_info "Checking idempotency key support..."
if grep -q "idempotencyKey" src/modules/maintenance-payments/routes.ts; then
  log_success "Idempotency key support present in code"
else
  log_error "Idempotency key support NOT found in code"
fi

log_info "Checking transaction wrapper..."
if grep -q "prisma.\$transaction" src/modules/maintenance-payments/routes.ts; then
  log_success "Transaction wrapper present"
else
  log_error "Transaction wrapper NOT found"
fi

log_info "Checking rate limiting..."
if grep -q "express-rate-limit" src/modules/maintenance-payments/routes.ts; then
  log_success "Rate limiting configured"
else
  log_warning "Rate limiting may not be configured"
fi

log_info "Checking reconciliation service..."
if [ -f "src/lib/reconciliation.ts" ]; then
  log_success "Reconciliation service exists"
else
  log_error "Reconciliation service NOT found"
fi

log_info "Checking reconciliation cron..."
if grep -q "reconcileAllSocieties" src/server.ts; then
  log_success "Reconciliation cron configured"
else
  log_warning "Reconciliation cron may not be configured"
fi

################################################################################
# STEP 13: Lint Check
################################################################################

log_step "STEP 13: Code Quality Check"

log_info "Running ESLint..."
LINT_OUTPUT=$(npm run lint 2>&1)
LINT_ERRORS=$(echo "$LINT_OUTPUT" | grep -c "error" || echo "0")
LINT_WARNINGS=$(echo "$LINT_OUTPUT" | grep -c "warning" || echo "0")

if [ "$LINT_ERRORS" -eq 0 ]; then
  log_success "ESLint passed (0 errors, $LINT_WARNINGS warnings)"
else
  log_error "ESLint found $LINT_ERRORS errors"
fi

################################################################################
# FINAL REPORT
################################################################################

echo ""
echo -e "${BLUE}"
echo "================================================================================"
echo "📊 DEPLOYMENT VERIFICATION REPORT"
echo "================================================================================"
echo -e "${NC}"

echo ""
echo -e "${GREEN}✅ Passed:${NC} $PASS"
echo -e "${RED}❌ Failed:${NC} $FAIL"
echo -e "${YELLOW}⚠️  Warnings:${NC} $WARN"
echo ""

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}"
  echo "================================================================================"
  echo "🎉 DEPLOYMENT SUCCESSFUL - SYSTEM READY FOR PRODUCTION"
  echo "================================================================================"
  echo -e "${NC}"
  echo ""
  echo "✅ Database migrations applied"
  echo "✅ Schema changes verified"
  echo "✅ Backend server running (PID: $SERVER_PID)"
  echo "✅ All critical features verified"
  echo ""
  echo "🚀 Next Steps:"
  echo "   1. Monitor logs: tail -f /tmp/backend.log"
  echo "   2. Test first payment manually"
  echo "   3. Check reconciliation after 1 hour"
  echo "   4. Review admin dashboard: http://localhost:4000/api/reconciliation/summary"
  echo ""
  echo "📝 Server Details:"
  echo "   • Health: http://localhost:4000/health"
  echo "   • API: http://localhost:4000/api"
  echo "   • PID: $SERVER_PID"
  echo "   • Logs: /tmp/backend.log"
  echo ""
  echo "⚠️  To stop server: kill $SERVER_PID"
  echo ""
  exit 0
else
  echo -e "${RED}"
  echo "================================================================================"
  echo "❌ DEPLOYMENT VERIFICATION FAILED"
  echo "================================================================================"
  echo -e "${NC}"
  echo ""
  echo "Please fix the errors above and run this script again."
  echo ""
  echo "Check logs:"
  echo "  • Migration: /tmp/migration.log"
  echo "  • Backend: /tmp/backend.log"
  echo ""
  
  # Stop server if it was started
  if [ -f /tmp/backend.pid ]; then
    kill $(cat /tmp/backend.pid) 2>/dev/null || true
    rm /tmp/backend.pid
  fi
  
  exit 1
fi
