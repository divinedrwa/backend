-- A parcel can be for one floor (unit) of a flat. NULL = the whole flat, as before.
ALTER TABLE "Parcel" ADD COLUMN IF NOT EXISTS "unitId" TEXT;

CREATE INDEX IF NOT EXISTS "Parcel_unitId_idx" ON "Parcel"("unitId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Parcel_unitId_fkey') THEN
    ALTER TABLE "Parcel"
      ADD CONSTRAINT "Parcel_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
