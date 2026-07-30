-- Public visitor-pass links use a high-entropy bearer token. Only its SHA-256
-- hash is stored, so a database read cannot reveal usable pass URLs.
ALTER TABLE "PreApprovedVisitor"
ADD COLUMN "publicPassTokenHash" VARCHAR(64),
ADD COLUMN "publicPassIssuedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "PreApprovedVisitor_publicPassTokenHash_key"
ON "PreApprovedVisitor"("publicPassTokenHash");
