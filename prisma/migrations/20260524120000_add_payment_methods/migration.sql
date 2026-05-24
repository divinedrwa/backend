-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('BANK_TRANSFER', 'UPI_VPA', 'UPI_QR', 'RAZORPAY', 'PHONEPE');

-- AlterEnum
ALTER TYPE "PaymentMode" ADD VALUE 'PHONEPE';

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "type" "PaymentMethodType" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "displayName" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL DEFAULT '{}',
    "legacyBankAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_legacyBankAccountId_key" ON "PaymentMethod"("legacyBankAccountId");

-- CreateIndex
CREATE INDEX "PaymentMethod_societyId_isEnabled_idx" ON "PaymentMethod"("societyId", "isEnabled");

-- CreateIndex
CREATE INDEX "PaymentMethod_societyId_type_idx" ON "PaymentMethod"("societyId", "type");

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- DATA MIGRATION: Copy existing payment config into PaymentMethod rows
-- ============================================================================

-- 1. Migrate BankAccount rows → PaymentMethod (type = BANK_TRANSFER)
INSERT INTO "PaymentMethod" ("id", "societyId", "type", "isEnabled", "displayName", "sortOrder", "config", "legacyBankAccountId", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    ba."societyId",
    'BANK_TRANSFER'::"PaymentMethodType",
    ba."isActive",
    ba."bankName" || ' - ' || ba."accountType",
    0,
    jsonb_build_object(
        'bankName', ba."bankName",
        'accountNumber', ba."accountNumber",
        'ifscCode', ba."ifscCode",
        'accountHolderName', ba."accountHolderName",
        'accountType', ba."accountType"
    ),
    ba."id",
    ba."createdAt",
    NOW()
FROM "BankAccount" ba;

-- 2. Migrate Society.upiVpa → PaymentMethod (type = UPI_VPA)
INSERT INTO "PaymentMethod" ("id", "societyId", "type", "isEnabled", "displayName", "sortOrder", "config", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    s."id",
    'UPI_VPA'::"PaymentMethodType",
    true,
    'UPI',
    10,
    jsonb_build_object('vpa', s."upiVpa"),
    NOW(),
    NOW()
FROM "Society" s
WHERE s."upiVpa" IS NOT NULL AND s."upiVpa" != '';

-- 3. Migrate Society.upiQrCodeUrl → PaymentMethod (type = UPI_QR)
INSERT INTO "PaymentMethod" ("id", "societyId", "type", "isEnabled", "displayName", "sortOrder", "config", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    s."id",
    'UPI_QR'::"PaymentMethodType",
    true,
    'UPI QR Code',
    11,
    jsonb_build_object('qrCodeUrl', s."upiQrCodeUrl"),
    NOW(),
    NOW()
FROM "Society" s
WHERE s."upiQrCodeUrl" IS NOT NULL AND s."upiQrCodeUrl" != '';
