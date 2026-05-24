-- CreateEnum
CREATE TYPE "ComplaintPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN "priority" "ComplaintPriority" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN "slaDeadline" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Complaint_slaDeadline_idx" ON "Complaint"("slaDeadline");
