-- CreateEnum
CREATE TYPE "SpecialProjectStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SpecialProjectType" AS ENUM ('REPAIR', 'UPGRADE', 'PURCHASE', 'EVENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ProjectContributionStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID');

-- AlterEnum
ALTER TYPE "NotificationCategory" ADD VALUE 'PROJECT';

-- CreateTable
CREATE TABLE "special_projects" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "SpecialProjectType" NOT NULL DEFAULT 'OTHER',
    "status" "SpecialProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "targetAmount" DECIMAL(12,2) NOT NULL,
    "totalCollected" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalExpenses" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "special_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_contributions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "villaId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "ProjectContributionStatus" NOT NULL DEFAULT 'UNPAID',
    "dueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_payments" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMode" NOT NULL DEFAULT 'CASH',
    "reference" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "markedById" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_expenses" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "vendor" TEXT,
    "receiptUrl" TEXT,
    "expenseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "special_projects_societyId_status_idx" ON "special_projects"("societyId", "status");

-- CreateIndex
CREATE INDEX "special_projects_societyId_idx" ON "special_projects"("societyId");

-- CreateIndex
CREATE INDEX "project_contributions_projectId_idx" ON "project_contributions"("projectId");

-- CreateIndex
CREATE INDEX "project_contributions_villaId_idx" ON "project_contributions"("villaId");

-- CreateIndex
CREATE UNIQUE INDEX "project_contributions_projectId_villaId_key" ON "project_contributions"("projectId", "villaId");

-- CreateIndex
CREATE UNIQUE INDEX "project_payments_idempotencyKey_key" ON "project_payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "project_payments_contributionId_idx" ON "project_payments"("contributionId");

-- CreateIndex
CREATE INDEX "project_expenses_projectId_idx" ON "project_expenses"("projectId");

-- AddForeignKey
ALTER TABLE "special_projects" ADD CONSTRAINT "special_projects_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_projects" ADD CONSTRAINT "special_projects_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_contributions" ADD CONSTRAINT "project_contributions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "special_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_contributions" ADD CONSTRAINT "project_contributions_villaId_fkey" FOREIGN KEY ("villaId") REFERENCES "Villa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_payments" ADD CONSTRAINT "project_payments_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "project_contributions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_payments" ADD CONSTRAINT "project_payments_markedById_fkey" FOREIGN KEY ("markedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_expenses" ADD CONSTRAINT "project_expenses_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "special_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_expenses" ADD CONSTRAINT "project_expenses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
