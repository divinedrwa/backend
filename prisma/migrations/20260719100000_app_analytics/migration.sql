-- CreateEnum
CREATE TYPE "AppAnalyticsPlatform" AS ENUM ('ANDROID', 'IOS', 'WEB');

-- CreateEnum
CREATE TYPE "AppAnalyticsEventKind" AS ENUM ('SESSION_START', 'SESSION_END', 'LOGIN', 'LOGOUT', 'SCREEN_VIEW', 'FLOW_COMPLETE', 'ACTION', 'ERROR');

-- CreateTable
CREATE TABLE "app_analytics_sessions" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "platform" "AppAnalyticsPlatform" NOT NULL,
    "appVersion" TEXT,
    "buildNumber" TEXT,
    "deviceId" TEXT,
    "deviceModel" TEXT,
    "osVersion" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_analytics_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_analytics_events" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "platform" "AppAnalyticsPlatform" NOT NULL,
    "appVersion" TEXT,
    "kind" "AppAnalyticsEventKind" NOT NULL,
    "name" TEXT NOT NULL,
    "durationMs" INTEGER,
    "success" BOOLEAN,
    "properties" JSONB,
    "clientEventId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_analytics_sessions_societyId_startedAt_idx" ON "app_analytics_sessions"("societyId", "startedAt");

-- CreateIndex
CREATE INDEX "app_analytics_sessions_userId_startedAt_idx" ON "app_analytics_sessions"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "app_analytics_sessions_societyId_lastSeenAt_idx" ON "app_analytics_sessions"("societyId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "app_analytics_events_societyId_clientEventId_key" ON "app_analytics_events"("societyId", "clientEventId");

-- CreateIndex
CREATE INDEX "app_analytics_events_societyId_occurredAt_idx" ON "app_analytics_events"("societyId", "occurredAt");

-- CreateIndex
CREATE INDEX "app_analytics_events_societyId_kind_occurredAt_idx" ON "app_analytics_events"("societyId", "kind", "occurredAt");

-- CreateIndex
CREATE INDEX "app_analytics_events_societyId_name_occurredAt_idx" ON "app_analytics_events"("societyId", "name", "occurredAt");

-- CreateIndex
CREATE INDEX "app_analytics_events_userId_occurredAt_idx" ON "app_analytics_events"("userId", "occurredAt");

-- AddForeignKey
ALTER TABLE "app_analytics_sessions" ADD CONSTRAINT "app_analytics_sessions_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_analytics_sessions" ADD CONSTRAINT "app_analytics_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_analytics_events" ADD CONSTRAINT "app_analytics_events_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_analytics_events" ADD CONSTRAINT "app_analytics_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "app_analytics_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_analytics_events" ADD CONSTRAINT "app_analytics_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
