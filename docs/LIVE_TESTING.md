# Live production testing

Validate against **live** (`https://gatepass-v037.onrender.com`). No staging required.

## Rules

- **Read-only on live** — no payments, visitors, parcels, or ledger writes
- `MOBILE_SMOKE_READ_ONLY=1` skips mutation smokes
- Mutating tests: local sandbox only (`qa-sandbox-society`), re-seed after

## Setup

```bash
cp env.smoke.example .env.smoke
# Edit SMOKE_SUPER_*, SMOKE_TENANT_ADMIN_*, MOBILE_SMOKE_RESIDENT_* (villa 25)
```

## Commands

```bash
npm run k5:live              # full gate + docs/LIVE_RELEASE_REPORT.md
npm run smoke:live           # health + optional mobile GETs
npm run smoke:live:villa25   # Divine Residency villa 25 deep read smoke
npm run smoke:live:phase4-billing  # Phase 4 charge heads + billing settings (GET only)
```

### Phase 4 billing (no local DB)

Static logic tests need **no database** (fake clients / pure functions):

```bash
cd backend
npm run prisma:generate
npm run typecheck
npx tsx --test src/lib/chargeHeads.test.ts src/lib/maintenanceAmount.test.ts
npm run test:payments && npm run test:finance
```

After deploy to live, read-only verification:

```bash
cd backend && npm run smoke:live:phase4-billing
```

See skill: `.cursor/skills/verify-phase4-billing-live/SKILL.md`
