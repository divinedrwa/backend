-- AlterTable
ALTER TABLE "app_analytics_sessions" ADD COLUMN "userName" TEXT,
ADD COLUMN "username" TEXT,
ADD COLUMN "villaNumber" TEXT,
ADD COLUMN "userIsActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "app_analytics_events" ADD COLUMN "userName" TEXT,
ADD COLUMN "username" TEXT,
ADD COLUMN "villaNumber" TEXT,
ADD COLUMN "userIsActive" BOOLEAN NOT NULL DEFAULT true;
