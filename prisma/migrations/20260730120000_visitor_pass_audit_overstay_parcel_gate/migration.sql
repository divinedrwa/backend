-- Pre-approved pass view audit
CREATE TABLE "PreApprovedPassView" (
    "id" TEXT NOT NULL,
    "preApprovedId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" VARCHAR(64),
    "userAgent" VARCHAR(512),

    CONSTRAINT "PreApprovedPassView_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PreApprovedPassView_preApprovedId_viewedAt_idx"
ON "PreApprovedPassView"("preApprovedId", "viewedAt");

ALTER TABLE "PreApprovedPassView"
ADD CONSTRAINT "PreApprovedPassView_preApprovedId_fkey"
FOREIGN KEY ("preApprovedId") REFERENCES "PreApprovedVisitor"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Visitor overstay tracking
ALTER TABLE "Visitor"
ADD COLUMN "expectedCheckoutAt" TIMESTAMP(3),
ADD COLUMN "overstayNotifiedAt" TIMESTAMP(3);

CREATE INDEX "Visitor_societyId_expectedCheckoutAt_idx"
ON "Visitor"("societyId", "expectedCheckoutAt");

-- Parcel leave-at-gate handoff
ALTER TABLE "Parcel" ADD COLUMN "leftAtGate" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Parcel_societyId_leftAtGate_status_idx"
ON "Parcel"("societyId", "leftAtGate", "status");
