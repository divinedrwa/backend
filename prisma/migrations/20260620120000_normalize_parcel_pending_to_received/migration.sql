-- Normalize legacy admin-created parcels: PENDING meant "awaiting pickup" but
-- guard/resident flows use RECEIVED. Only rows not yet collected are updated.
UPDATE "Parcel"
SET "status" = 'RECEIVED', "updatedAt" = NOW()
WHERE "status" = 'PENDING'
  AND "collectedAt" IS NULL;
