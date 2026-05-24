-- AlterTable: add soft-delete column to Expense
ALTER TABLE "Expense" ADD COLUMN "deletedAt" TIMESTAMP(3);
