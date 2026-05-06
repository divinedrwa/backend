-- CreateEnum
CREATE TYPE "AdditionalFundDestination" AS ENUM ('MERGE_WITH_MAINTENANCE', 'KEEP_SEPARATE');

-- CreateTable
CREATE TABLE "AdditionalFund" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "receivedDate" TIMESTAMP(3) NOT NULL,
    "month" INTEGER,
    "year" INTEGER,
    "destination" "AdditionalFundDestination" NOT NULL DEFAULT 'MERGE_WITH_MAINTENANCE',
    "source" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdditionalFund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdditionalFund_societyId_idx" ON "AdditionalFund"("societyId");

-- CreateIndex
CREATE INDEX "AdditionalFund_month_year_idx" ON "AdditionalFund"("month", "year");

-- CreateIndex
CREATE INDEX "AdditionalFund_destination_idx" ON "AdditionalFund"("destination");

-- AddForeignKey
ALTER TABLE "AdditionalFund" ADD CONSTRAINT "AdditionalFund_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
