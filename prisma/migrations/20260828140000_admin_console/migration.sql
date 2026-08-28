-- Who may use the operator console.
--
-- A property of the person, not of an organisation: an operator opens
-- organisations they are not a member of. Defaults to false, so this migration
-- grants nobody anything — the first admin is granted below, by email, and
-- only if that account already exists.
ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;

-- What an operator did, when, and to whom.
CREATE TABLE "AdminAuditLog" (
    "id"          SERIAL       NOT NULL,
    "actorUserId" INTEGER      NOT NULL,
    "actorEmail"  TEXT,
    "action"      TEXT         NOT NULL,
    "targetType"  TEXT         NOT NULL,
    "targetId"    TEXT         NOT NULL,
    "summary"     TEXT         NOT NULL,
    "before"      JSONB,
    "after"       JSONB,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAuditLog_createdAt_idx"            ON "AdminAuditLog"("createdAt");
CREATE INDEX "AdminAuditLog_targetType_targetId_idx"  ON "AdminAuditLog"("targetType", "targetId");
CREATE INDEX "AdminAuditLog_actorUserId_idx"          ON "AdminAuditLog"("actorUserId");

-- The first admin, so there is somebody who can grant the rest.
--
-- Keyed on an email that has already signed in; if it has not, this updates no
-- rows and the grant has to be made by hand. Deliberately not an INSERT: a User
-- row is created by the SSO at sign-in and inventing one here would produce an
-- account with no `ssoId` to authenticate against.
UPDATE "User" SET "isAdmin" = true WHERE lower("email") = 'draskenlabs@gmail.com';
