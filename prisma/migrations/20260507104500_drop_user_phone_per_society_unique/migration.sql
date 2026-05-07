-- Allow the same phone on multiple users in one society (e.g. one person as owner in villa A
-- and tenant in villa B — separate accounts per villa until multi-villa membership exists).
DROP INDEX IF EXISTS "User_phone_societyId_key";
