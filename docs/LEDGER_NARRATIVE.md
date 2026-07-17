# Ledger narrative (Phase 1 — A1)

Single source of truth for **what updates which table** when money moves.

## Three ledgers (by design)

| Store | Table / model | What it represents |
|-------|----------------|-------------------|
| **Villa snapshot** | `VillaMaintenanceSnapshot.paidAmount` | Per-villa, per–collection-cycle **settled** amount (cash + applied credit). Updated by **credit walker** after `MaintenancePayment` rows change. |
| **Cash ledger** | `MaintenancePayment` | Each **cash event** (admin cash/UPI verify, gateway settle). Source of truth for **society cash received**. |
| **Resident billing UI** | `UserCyclePayment` | Per-resident, per–**billing-cycle** status for mobile/admin billing screens. Synced from snapshot after walker; gateway rows use **cash-only** `amountPaid`. |

## Write paths (canonical)

**Import from `src/lib/ledgerWrites.ts` only** — do not create `MaintenancePayment` rows in route handlers.

1. **Admin mark-paid / bulk / legacy** → `recordPaymentAndSyncLedgers`
2. **Gateway (Razorpay / PhonePe)** → `recordPaymentAndSyncLedgers` via `gateway-payment-settle`
3. **UPI verify** → `recordPaymentAndSyncLedgers`
4. **Apply advance credit** → `recordCreditMarkerPayment`
5. **Reverse payment (L1)** → `reverseMaintenancePayment` (offset row, never deleteMany)

**Rule:** Never increment `VillaMaintenanceSnapshot.paidAmount` inline in handlers — always re-derive via credit walker from `MaintenancePayment` sum.

## Reconciliation (A2)

Hourly `reconcileSocietyLedger`:

- Compares sum of `VillaMaintenanceSnapshot.paidAmount` per collection cycle vs reconciled cash (`max(MP, UCP)` per villa-cycle).
- Tolerance: **₹0.01**.
- **Auto-resolve** open `ReconciliationAlert` when matched.
- **Refresh** `villaSum` / `societyCash` / `difference` on open alerts when still mismatched.

## Duplicate prevention (A4)

- `idempotencyKey` on gateway and client retries → reuse row.
- Manual cash: `findLikelyDuplicateMaintenancePayment` blocks same villa + month + year + amount + mode within **24h** → `409 DUPLICATE_PAYMENT_SUSPECTED`.

## Invariants (never violate)

1. Sum of villa snapshot paid per cycle reconciles to society cash within ₹0.01 after every payment op.
2. One idempotency key → one `MaintenancePayment` row.
3. `UserCyclePayment.amountPaid` for gateway = cash portion, not credit-inflated snapshot total (see `billing-collection-link`).

See also: [LEDGER_SYNC.md](./LEDGER_SYNC.md), [FINANCIAL_SYSTEM_REVIEW_AND_REDESIGN.md](../../docs/FINANCIAL_SYSTEM_REVIEW_AND_REDESIGN.md).
