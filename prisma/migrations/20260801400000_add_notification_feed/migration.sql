-- The console's own notification feed.
--
-- A row is written whether or not a push was delivered: a sleeping device, a
-- browser that never granted permission, or a deployment with no Firebase
-- credentials must not lose the event. Push is the interruption; this is the
-- record behind the bell.
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "ssoOrgId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- The feed query: one user's rows, newest first.
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
-- The unread count, which runs on every page load.
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
