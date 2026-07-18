-- G5: resident payment dispute workflow (Phase 4 Slice 4)

CREATE TYPE "PaymentDisputeStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED');

CREATE TABLE "PaymentDispute" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "villaId" TEXT,
    "cycleKey" TEXT,
    "maintenancePaymentId" TEXT,
    "amount" DECIMAL(12,2),
    "reason" TEXT NOT NULL,
    "residentNote" TEXT,
    "adminNote" TEXT,
    "status" "PaymentDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentDispute_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentDispute_societyId_status_idx" ON "PaymentDispute"("societyId", "status");
CREATE INDEX "PaymentDispute_userId_idx" ON "PaymentDispute"("userId");
CREATE INDEX "PaymentDispute_villaId_idx" ON "PaymentDispute"("villaId");
CREATE INDEX "PaymentDispute_societyId_createdAt_idx" ON "PaymentDispute"("societyId", "createdAt");

ALTER TABLE "PaymentDispute" ADD CONSTRAINT "PaymentDispute_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentDispute" ADD CONSTRAINT "PaymentDispute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentDispute" ADD CONSTRAINT "PaymentDispute_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentDispute" ADD CONSTRAINT "PaymentDispute_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
