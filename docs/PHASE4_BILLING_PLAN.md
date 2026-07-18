# Phase 4 — Billing product plan

**Started:** 2026-07-17  
**Target:** 9.5/10 — societies reduce Excel; multi-head bills + onboarding  
**Safety:** Opt-in per society; FIXED flat billing unchanged by default

---

## Already shipped (before Phase 4 kickoff)

| ID | Item | Status |
|----|------|--------|
| A7 | Auto monthly cycles | ✅ `AUTO_MAINTENANCE_CYCLES` cron |
| A13 | Late fee engine | ✅ Existing |
| G2 | Defaulter report | ✅ `/defaulter-report` + outstanding-dues |
| A9 (partial) | FIXED vs SQFT settings | ✅ Society settings UI + `maintenanceAmount.ts` |

---

## Execution slices (in order)

### Slice 0 — A9 end-to-end ✅

**Goal:** Publish/sync uses society FIXED or SQFT when generating villa snapshots.

| Task | Status |
|------|--------|
| Rule from society config on billing publish | ✅ `billing-collection-link.ts` |
| Per-villa `expectedAmount` from rule + villa area | ✅ `generateSnapshotsForBillingCycle` |
| Tests | ✅ `chargeHeads.test.ts` (SQFT path) |

**Live safety:** Default `MaintenanceBillingMode.FIXED` — Divine Residency unchanged unless admin switches to SQFT.

---

### Slice 1 — A8 charge heads (P1) — deployed core ✅

**Goal:** Maintenance + sinking + parking on one invoice (opt-in).

1. **Schema:** `SocietyChargeHead`, `VillaCycleChargeLine` ✅ deployed live
2. **API:** CRUD charge heads under `/society-settings/charge-heads` ✅
3. **Snapshots:** `expectedAmount` = sum(lines); keep payment/reconciliation unchanged ✅
4. **UI:** Society settings → Billing tab charge heads section ✅ deployed Vercel
5. **Invoice PDF:** line items when lines exist ✅
6. **Mobile:** `chargeLines[]` on resident maintenance API ✅

**Live verified 2026-07-18:** K5 green; Divine Residency `useChargeHeads=false`, 0 charge heads, reconciliation healthy. **Live API sandbox trial** (`qa-sandbox-society`): 2 charge heads → publish → `expectedAmount=₹1200` = line sum → reconciliation clean; Divine unchanged.

Societies with **zero charge heads** → current single-line behavior.

---

### Slice 2 — A10 ad-hoc invoices (P2) — shipped via Special Projects ✅

**Decision:** Reuse existing `SpecialProject` / `ProjectContribution` — no new ledger model. Keeps maintenance reconciliation isolated; ad-hoc dues are a separate collection track (already in admin web + Flutter).

| Task | Status |
|------|--------|
| Multi-villa assessments (projects UI + mobile) | ✅ pre-existing |
| `POST /special-projects/ad-hoc-charge` — single-villa penalty / event fee shortcut | ✅ |
| Resident maintenance API surfaces `specialProjectDues` + `grandTotalDue` | ✅ |
| Payment recording on contributions (cash/UPI) | ✅ pre-existing |

**API examples:**

```http
POST /api/special-projects/ad-hoc-charge
{ "title": "Parking penalty", "villaId": "…", "amount": 500, "type": "OTHER" }

POST /api/special-projects/ad-hoc-charge
{ "title": "Diwali event", "charges": [{ "villaId": "…", "amount": 200 }] }
```

Resident `GET /residents/maintenance-pending` and `maintenance-dashboard` now include `specialProjectDues[]`, `specialProjectDueTotal`, and `grandTotalDue` (maintenance + ad-hoc).

---

### Slice 3 — G1 onboarding wizard (P1) — deferred

Guided UI from `GO_LIVE_CHECKLIST.md` (villas → gates → payment methods → first cycle). **Skipped** — manual checklist + existing admin pages remain.

---

### Slice 4 — G4 + G5 (P2) — backend ✅

| Task | Status |
|------|--------|
| **G4** `GET /residents/maintenance-statement/pdf?financialYearId=` — FY PDF (cycles + payments) | ✅ |
| **G5** `PaymentDispute` model + resident create/list + admin list/update | ✅ |
| Admin web UI for disputes | ✅ `/payment-disputes` |
| Mobile dispute + FY PDF buttons | ✅ Report payment issue on maintenance hub; G4 API ready |

**G4 example:** `GET /api/residents/maintenance-statement/pdf?financialYearId=<fyId>`

**G5 examples:**

```http
POST /api/residents/payment-disputes
{ "reason": "Paid but not reflected", "cycleKey": "2026-07", "amount": 1500, "residentNote": "…" }

GET /api/payment-disputes?status=OPEN
PATCH /api/payment-disputes/:id  { "status": "RESOLVED", "adminNote": "…" }
```

---

### Slice 5 — A11–A12 (P2, optional)

UTR auto-verify, bank CSV import — external integrations.

---

## Phase 4 gate (definition of done)

- [x] Slice 0: SQFT publish produces per-villa amounts on staging/local sandbox
- [x] Slice 1: One society on charge heads; invoice shows breakdown; reconciliation still clean *(local + live sandbox trial 2026-07-18; Divine unchanged)*
- [x] Slice 2: Ad-hoc charges via Special Projects + maintenance API integration *(2026-07-18)*
- [x] Slice 4 (backend): G4 FY statement PDF + G5 payment disputes API *(2026-07-18)*
- [ ] G2 aging buckets (optional enhancement)
- [x] K5 live pass after each deploy *(live-20260718)*
- [x] No regression on Divine Residency FIXED billing

---

## Commands

```bash
cd backend && npm run test:payments && npm run test:finance
npm run k5:live   # after deploy
```

See [RELEASE_CLOSURE_JUL2026.md](./RELEASE_CLOSURE_JUL2026.md) for prior batch closure.
