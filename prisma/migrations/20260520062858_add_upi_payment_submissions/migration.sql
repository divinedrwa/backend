-- CreateEnum
CREATE TYPE "UpiPaymentStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- AlterTable
ALTER TABLE "Society" ADD COLUMN     "upiVpa" TEXT;

-- CreateTable
CREATE TABLE "upi_payment_submissions" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "cycleId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "upiTransactionRef" TEXT,
    "status" "UpiPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "verifiedByAdminId" TEXT,
    "rejectionReason" TEXT,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,

    CONSTRAINT "upi_payment_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upi_payment_submissions_societyId_status_idx" ON "upi_payment_submissions"("societyId", "status");

-- CreateIndex
CREATE INDEX "upi_payment_submissions_userId_idx" ON "upi_payment_submissions"("userId");

-- AddForeignKey
ALTER TABLE "upi_payment_submissions" ADD CONSTRAINT "upi_payment_submissions_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upi_payment_submissions" ADD CONSTRAINT "upi_payment_submissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upi_payment_submissions" ADD CONSTRAINT "upi_payment_submissions_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upi_payment_submissions" ADD CONSTRAINT "upi_payment_submissions_verifiedByAdminId_fkey" FOREIGN KEY ("verifiedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
