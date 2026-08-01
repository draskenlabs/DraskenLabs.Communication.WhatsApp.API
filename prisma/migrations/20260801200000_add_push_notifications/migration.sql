-- Firebase Cloud Messaging support.
--
-- DeviceToken holds one row per browser/app registration. The token is unique
-- because Firebase reissues the same value to the same device: re-registering
-- must update the row rather than pile up duplicates. ssoOrgId is recorded so a
-- push about one organisation never reaches a device signed in to another.
CREATE TABLE "DeviceToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "ssoOrgId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'web',
    "userAgent" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");
CREATE INDEX "DeviceToken_userId_idx" ON "DeviceToken"("userId");
CREATE INDEX "DeviceToken_ssoOrgId_idx" ON "DeviceToken"("ssoOrgId");

ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Per-user opt-outs. A missing row means everything is on, so existing users
-- need no backfill.
CREATE TABLE "NotificationPreference" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "inboundMessage" BOOLEAN NOT NULL DEFAULT true,
    "templateStatus" BOOLEAN NOT NULL DEFAULT true,
    "messageFailed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");

ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
