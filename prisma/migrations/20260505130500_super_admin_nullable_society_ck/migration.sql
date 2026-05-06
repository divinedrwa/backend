-- Drop NOT NULL on User.societyId (platform users have no tenant)
ALTER TABLE "User" ALTER COLUMN "societyId" DROP NOT NULL;

-- Enforce: SUPER_ADMIN <=> societyId IS NULL; other roles require societyId
ALTER TABLE "User" ADD CONSTRAINT "User_society_role_ck" CHECK (
  (role = 'SUPER_ADMIN'::"UserRole" AND "societyId" IS NULL)
  OR
  (role <> 'SUPER_ADMIN'::"UserRole" AND "societyId" IS NOT NULL)
);
