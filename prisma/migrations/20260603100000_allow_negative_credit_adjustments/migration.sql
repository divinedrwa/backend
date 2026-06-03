-- Allow negative amounts for manual credit deductions (unlinked payments).
-- The original CHECK("amount" > 0) blocked the deduct-credit handler from
-- storing negative adjustments, causing a 500 Internal Server Error.
ALTER TABLE "MaintenancePayment" DROP CONSTRAINT IF EXISTS "check_amount_positive";
ALTER TABLE "MaintenancePayment" ADD CONSTRAINT "check_amount_non_zero" CHECK ("amount" <> 0);
