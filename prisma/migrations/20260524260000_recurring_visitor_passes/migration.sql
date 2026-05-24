-- AlterTable: Add recurring pass fields
ALTER TABLE "PreApprovedVisitor" ADD COLUMN "isRecurring" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "maxUses" INTEGER,
ADD COLUMN "usedCount" INTEGER NOT NULL DEFAULT 0;
