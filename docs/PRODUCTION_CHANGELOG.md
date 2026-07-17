# Production changelog (J6)

| Date | Version | Surfaces | Risk | Summary | Rollback |
|------|---------|----------|------|---------|----------|
| 2026-07-17 | live-20260717 | API `92c90c4`, admin `d66708d` | HIGH | Phase 0–3 batch: ledger/reconciliation, legal, live K5 smokes, reconciliation Advance UI | PRODUCTION_ROLLBACK_RUNBOOK.md |

### 2026-07-17 — live-20260717 (HIGH)

- **API** @ `92c90c4` — live-first read-only smoke gates (`k5:live`, `smoke:live:villa25`); prior money-trust stack on main
- **Admin web** @ `d66708d` — reconciliation Credit/Advance columns, ADVANCE OK badge, resolved variance clarity
- **Smoke:** K5 live gate ✅ (read-only on production)
- **Rollback:** Redeploy previous Render build; Vercel promote previous deployment

## Risk levels

- **LOW** — copy, UI-only, docs
- **MEDIUM** — new endpoints, additive migrations
- **HIGH** — payment/ledger/auth changes
- **CRITICAL** — schema contract change, breaking mobile API
