-- CreateTable
CREATE TABLE "GuardClientMutation" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "guardUserId" TEXT NOT NULL,
    "clientMutationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "visitorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuardClientMutation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuardClientMutation_societyId_clientMutationId_key" ON "GuardClientMutation"("societyId", "clientMutationId");

-- CreateIndex
CREATE INDEX "GuardClientMutation_guardUserId_createdAt_idx" ON "GuardClientMutation"("guardUserId", "createdAt");

-- CreateIndex
CREATE INDEX "GuardClientMutation_visitorId_idx" ON "GuardClientMutation"("visitorId");

-- AddForeignKey
ALTER TABLE "GuardClientMutation" ADD CONSTRAINT "GuardClientMutation_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "Society"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardClientMutation" ADD CONSTRAINT "GuardClientMutation_guardUserId_fkey" FOREIGN KEY ("guardUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardClientMutation" ADD CONSTRAINT "GuardClientMutation_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "Visitor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
