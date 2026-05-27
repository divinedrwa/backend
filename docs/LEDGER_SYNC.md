# Maintenance & billing ledger sync

The platform stores maintenance money in **three coupled layers**. Any write that updates only one layer causes the bugs users see (e.g. admin grid **PENDING** while mobile **`isPaid: true`**).

## Data layers

| Layer | Tables | Consumed by |
|-------|--------|-------------|
| **Billing (resident app)** | `user_payments` (`UserCyclePayment`) | Flutter/Next `GET /v1/cycles/current`, pay-all, gateways |
| **Maintenance cash ledger** | `MaintenancePayment`, `Maintenance` | Society fund balance, credit walker |
| **Cycle snapshots (admin grid)** | `VillaMaintenanceSnapshot`, `MaintenanceCollectionCycle` | Maintenance Management UI, `GET /residents/maintenance-*` pending counts |

**Source of truth for snapshot `paidAmount` / status:** credit walker re-derives from `MaintenancePayment` rows linked to `maintenanceCollectionCycleId`.

**Source of truth for resident `isPaid`:** `user_payments.amountPaid` vs cycle `amount` (see `buildCurrentCycleResponse`).

## Central sync API (`billing-collection-link.ts`)

| Function | Direction | When to call |
|----------|-----------|--------------|
| `postMarkCashToMaintenanceLedger` | Billing cash → `MaintenancePayment` + walker | Mark-cash on billing |
| `syncBillingUserCyclePaymentsFromSnapshot` | Snapshot → `user_payments` | After snapshot/walker changes |
| `syncAllUserCyclePaymentsForMaintenanceCycle` | All villas in a month | Generate snapshots, billing↔collection sync |
| `reconcileVillaLedgerFromUserCyclePayment` | `user_payments` SUCCESS → backfill `MaintenancePayment` gap | Repair billing-ahead-of-snapshot |
| `ensureVillaLedgersAligned` | Full villa: reconcile → walker → snapshot→billing | End of every mutation |
| `reconcileAllVillasForBillingCycle` | All PRIMARY villas for one billing cycle | Billing/collection sync, grid load |

Gateway (PhonePe/Razorpay) uses `ledger-sync.ts` → `syncLedgerForPayment` (already ensures collection cycle + snapshot).

## Mutation hooks (backend)

| Endpoint | Sync |
|----------|------|
| `POST /v1/admin/payments/mark-cash` | `postMarkCashToMaintenanceLedger` + `ensureVillaLedgersAligned` |
| `POST /maintenance-management/mark-paid` | Credit walker + `ensureVillaLedgersAligned` |
| `POST /maintenance-management/reverse-payment` | Walker + `syncBillingUserCyclePaymentsFromSnapshot` |
| `PUT .../custom-amount`, `villa-grid-row` | Snapshot update + `syncBillingUserCyclePaymentsFromSnapshot` / `ensureVillaLedgersAligned` |
| `POST .../generate-snapshots` | `syncAllUserCyclePaymentsForMaintenanceCycle` |
| `POST .../billing-cycles/:id/sync` | `reconcileAllVillasForBillingCycle` |
| `GET .../cycles/:id/grid` | **Auto-repair:** `reconcileAllVillasForBillingCycle` before returning rows |
| Gateway webhooks / poll | `syncLedgerForPayment` |
| User villa / PRIMARY change | `realignVillaBillingFromSnapshots` |

## Roles

PRIMARY billing contact sync includes **`RESIDENT` and `ADMIN`** (`residentLikeRoleFilter`). Admins with a villa must be treated like residents for all ledger operations.

## Clients

| Client | After admin/billing payment change |
|--------|-----------------------------------|
| **Maintenance Management** (`page.tsx`) | Already calls `billing-cycles/:id/sync` then loads grid |
| **Maintenance Billing** (`maintenance-billing/page.tsx`) | After mark-cash, calls same sync endpoint |
| **Flutter** | `invalidateMaintenancePaymentProviders` + push `MAINTENANCE_*` types in `main.dart` / `notification_service.dart` |

## Operational repair

If data is already mismatched in production:

1. Deploy latest backend.
2. Open **Maintenance Management** for the month (grid load runs reconcile), or  
   `POST /api/maintenance-management/collection/billing-cycles/{billingCycleId}/sync`
3. Resident app: pull-to-refresh or reopen Home (invalidates billing providers).

## Adding new payment features

Any new code that writes `user_payments`, `MaintenancePayment`, or `VillaMaintenanceSnapshot` must end with **`ensureVillaLedgersAligned`** (single villa) or **`reconcileAllVillasForBillingCycle`** (whole cycle), inside the same DB transaction when possible.
