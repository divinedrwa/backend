/**
 * A1 — Single entry surface for all money ledger mutations.
 *
 * Route handlers must call these functions (inside prisma.$transaction) instead of
 * creating MaintenancePayment rows inline. See docs/LEDGER_NARRATIVE.md.
 */
export {
  recordPaymentAndSyncLedgers,
  recordCreditMarkerPayment,
  type RecordPaymentParams,
  type CreditMarkerParams,
} from "../modules/maintenance-payments/record-payment";

export { reverseMaintenancePayment, PaymentReversalError } from "./reverseMaintenancePayment";

export { applyVillaCreditAcrossSnapshots } from "../modules/maintenance-management/credit-walker";

export { syncVillaBillingCyclesFromSnapshots } from "../modules/billing-cycle/billing-collection-link";
