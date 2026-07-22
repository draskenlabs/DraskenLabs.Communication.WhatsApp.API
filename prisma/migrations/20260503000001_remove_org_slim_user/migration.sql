-- Add ssoOrgId to all tables that referenced Organisation
ALTER TABLE "Waba" ADD COLUMN "ssoOrgId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "UserApiKey" ADD COLUMN "ssoOrgId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Message" ADD COLUMN "ssoOrgId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Contact" ADD COLUMN "ssoOrgId" TEXT NOT NULL DEFAULT '';

-- Drop FK constraints from Organisation
ALTER TABLE "Waba" DROP CONSTRAINT "Waba_orgId_fkey";
ALTER TABLE "UserApiKey" DROP CONSTRAINT "UserApiKey_orgId_fkey";
ALTER TABLE "Message" DROP CONSTRAINT "Message_orgId_fkey";
ALTER TABLE "Contact" DROP CONSTRAINT "Contact_orgId_fkey";

-- Drop old orgId columns
ALTER TABLE "Waba" DROP COLUMN "orgId";
ALTER TABLE "UserApiKey" DROP COLUMN "orgId";
ALTER TABLE "Message" DROP COLUMN "orgId";

-- Contact unique constraint — rebuild on ssoOrgId.
-- NB: the old uniqueness was created via `CREATE UNIQUE INDEX` (an index,
-- not a table constraint), so it must be removed with DROP INDEX. Using
-- ALTER TABLE ... DROP CONSTRAINT here fails with 42704 ("constraint ... does
-- not exist").
DROP INDEX "Contact_orgId_phone_key";
ALTER TABLE "Contact" DROP COLUMN "orgId";
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_ssoOrgId_phone_key" UNIQUE ("ssoOrgId", "phone");

-- Remove temporary defaults (columns are populated at app level going forward)
ALTER TABLE "Waba" ALTER COLUMN "ssoOrgId" DROP DEFAULT;
ALTER TABLE "UserApiKey" ALTER COLUMN "ssoOrgId" DROP DEFAULT;
ALTER TABLE "Message" ALTER COLUMN "ssoOrgId" DROP DEFAULT;
ALTER TABLE "Contact" ALTER COLUMN "ssoOrgId" DROP DEFAULT;

-- Slim User table — identity only; profile data lives in SSO
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_email_key";
ALTER TABLE "User" DROP COLUMN IF EXISTS "firstName";
ALTER TABLE "User" DROP COLUMN IF EXISTS "lastName";
ALTER TABLE "User" DROP COLUMN IF EXISTS "email";
ALTER TABLE "User" DROP COLUMN IF EXISTS "status";
ALTER TABLE "User" DROP COLUMN IF EXISTS "activeOrgId";

-- Drop OrgMember FK constraints then the table itself
ALTER TABLE "OrgMember" DROP CONSTRAINT IF EXISTS "OrgMember_orgId_fkey";
ALTER TABLE "OrgMember" DROP CONSTRAINT IF EXISTS "OrgMember_userId_fkey";
DROP TABLE IF EXISTS "OrgMember";

-- Drop Organisation table
DROP TABLE IF EXISTS "Organisation";

-- Drop OrgRole enum
DROP TYPE IF EXISTS "OrgRole";
