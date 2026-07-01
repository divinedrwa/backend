-- A recurring pre-approval pass legitimately admits multiple visitors, so
-- Visitor.preApprovedId must NOT be unique. Drop the unique index and replace
-- it with a plain index (keeps the audit-trail lookup fast).
DROP INDEX IF EXISTS "Visitor_preApprovedId_key";
CREATE INDEX IF NOT EXISTS "Visitor_preApprovedId_idx" ON "Visitor"("preApprovedId");
