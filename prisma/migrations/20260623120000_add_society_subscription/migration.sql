-- CreateEnum
CREATE TYPE "SocietySubscriptionPlan" AS ENUM ('TRIAL', 'STARTER', 'GROWTH', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SocietySubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- CreateTable
CREATE TABLE "SocietySubscription" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "plan" "SocietySubscriptionPlan" NOT NULL DEFAULT 'TRIAL',
    "status" "SocietySubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "monthlyAmount" DECIMAL(12,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocietySubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SocietySubscription_societyId_key" ON "SocietySubscription"("societyId");

-- CreateIndex
CREATE INDEX "SocietySubscription_status_idx" ON "SocietySubscription"("status");

-- AddForeignKey
ALTER TABLE "SocietySubscription" ADD CONSTRAINT "SocietySubscription_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;
