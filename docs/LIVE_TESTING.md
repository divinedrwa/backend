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
```
