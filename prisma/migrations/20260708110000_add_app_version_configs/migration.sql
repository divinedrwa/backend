-- CreateTable
CREATE TABLE "app_version_configs" (
    "id" TEXT NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "latestVersion" TEXT NOT NULL,
    "minVersion" TEXT NOT NULL,
    "storeUrl" TEXT,
    "releaseNotes" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_version_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_version_configs_platform_key" ON "app_version_configs"("platform");
