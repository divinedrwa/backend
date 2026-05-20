-- AlterTable
ALTER TABLE "Society" ADD COLUMN     "guardCanApproveVisitors" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "visitorApprovalRequired" BOOLEAN NOT NULL DEFAULT false;
