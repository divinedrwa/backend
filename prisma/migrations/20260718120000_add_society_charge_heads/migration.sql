-- A8: configurable charge heads + per-snapshot line items (opt-in via Society.useChargeHeads).

CREATE TYPE "ChargeHeadAmountType" AS ENUM ('FIXED', 'PER_SQFT');

ALTER TABLE "Society" ADD COLUMN "useChargeHeads" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "SocietyChargeHead" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountType" "ChargeHeadAmountType" NOT NULL DEFAULT 'FIXED',
    "fixedAmount" DECIMAL(12,2),
    "perSqftRate" DECIMAL(12,4),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocietyChargeHead_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VillaCycleChargeLine" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "chargeHeadId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VillaCycleChargeLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocietyChargeHead_societyId_code_key" ON "SocietyChargeHead"("societyId", "code");
CREATE INDEX "SocietyChargeHead_societyId_isActive_idx" ON "SocietyChargeHead"("societyId", "isActive");

CREATE UNIQUE INDEX "VillaCycleChargeLine_snapshotId_chargeHeadId_key" ON "VillaCycleChargeLine"("snapshotId", "chargeHeadId");
CREATE INDEX "VillaCycleChargeLine_snapshotId_idx" ON "VillaCycleChargeLine"("snapshotId");

ALTER TABLE "SocietyChargeHead" ADD CONSTRAINT "SocietyChargeHead_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VillaCycleChargeLine" ADD CONSTRAINT "VillaCycleChargeLine_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "VillaMaintenanceSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VillaCycleChargeLine" ADD CONSTRAINT "VillaCycleChargeLine_chargeHeadId_fkey" FOREIGN KEY ("chargeHeadId") REFERENCES "SocietyChargeHead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
