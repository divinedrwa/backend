-- Scope UserCyclePayment.idempotencyKey uniqueness to (userId, idempotencyKey)
-- instead of globally. This only relaxes the constraint (previously a single
-- non-null key was globally unique), so no existing row can violate it.
DROP INDEX IF EXISTS "user_payments_idempotencyKey_key";

CREATE UNIQUE INDEX "user_payments_userId_idempotencyKey_key"
  ON "user_payments" ("userId", "idempotencyKey");
