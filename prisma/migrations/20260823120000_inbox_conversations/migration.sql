-- The inbox: a conversation is a thing, not a query.
--
-- Replies have been stored since the messages webhook was first handled, but
-- nothing could read them back. The missing piece was never the data — it was
-- the thread. "The newest message per counterparty, across an outbound table
-- and an inbound one" is not a query any index answers, and the conversation
-- list asks it on every poll. So the answer is written down as each message
-- lands, and the two message tables gain the indexes a thread needs.
--
-- Keyed per organisation, not per WABA: an account can be connected by several
-- organisations, and each has its own unread count, assignment and idea of
-- whether the thread is dealt with.

CREATE TYPE "ConversationStatus" AS ENUM ('open', 'closed');
CREATE TYPE "ConversationDirection" AS ENUM ('inbound', 'outbound');

CREATE TABLE "Conversation" (
    "id" SERIAL NOT NULL,
    "ssoOrgId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "contactName" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "lastDirection" "ConversationDirection" NOT NULL,
    "lastPreview" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastReadAt" TIMESTAMP(3),
    "status" "ConversationStatus" NOT NULL DEFAULT 'open',
    "assigneeUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Conversation_ssoOrgId_phoneNumberId_contactPhone_key"
    ON "Conversation"("ssoOrgId", "phoneNumberId", "contactPhone");
CREATE INDEX "Conversation_ssoOrgId_lastMessageAt_idx"
    ON "Conversation"("ssoOrgId", "lastMessageAt");
CREATE INDEX "Conversation_ssoOrgId_status_lastMessageAt_idx"
    ON "Conversation"("ssoOrgId", "status", "lastMessageAt");
CREATE INDEX "Conversation_wabaId_idx" ON "Conversation"("wabaId");

ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_wabaId_fkey"
    FOREIGN KEY ("wabaId") REFERENCES "Waba"("wabaId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- One conversation's replies, in order. Without this the thread query is a
-- sequential scan of every reply the account has ever received.
CREATE INDEX "InboundMessage_phoneNumberId_from_timestamp_idx"
    ON "InboundMessage"("phoneNumberId", "from", "timestamp");

-- The outbound half of the same thread.
CREATE INDEX "Message_ssoOrgId_phoneNumberId_to_createdAt_idx"
    ON "Message"("ssoOrgId", "phoneNumberId", "to", "createdAt");

-- Backfill, so the inbox opens with the history that already exists rather
-- than filling up from the next reply onwards.
--
-- Phone numbers are normalised to digits here for the same reason the write
-- path normalises them: Meta reports `from` bare, callers send `to` either
-- with or without a `+`, and the two spellings would otherwise be two threads.
WITH events AS (
    SELECT
        m."ssoOrgId"                                AS sso_org_id,
        p."wabaId"                                  AS waba_id,
        m."phoneNumberId"                           AS phone_number_id,
        regexp_replace(m."to", '[^0-9]', '', 'g')   AS contact_phone,
        NULL::TEXT                                  AS contact_name,
        m."createdAt"                               AS at,
        'outbound'::"ConversationDirection"         AS direction,
        CASE m."type"::TEXT
            WHEN 'text'     THEN m."payload"->'text'->>'body'
            WHEN 'template' THEN COALESCE(
                                     'Template · ' || m."templateName",
                                     'Template · ' || (m."payload"->'template'->>'name'),
                                     'Template')
            WHEN 'image'    THEN 'Photo'
            WHEN 'video'    THEN 'Video'
            WHEN 'audio'    THEN 'Voice message'
            WHEN 'document' THEN 'Document'
            WHEN 'location' THEN 'Location'
            WHEN 'contacts' THEN 'Contact'
            WHEN 'reaction' THEN 'Reaction'
            ELSE 'Message'
        END                                         AS preview
    FROM "Message" m
    -- Inner join: a send whose number has since been removed cannot be
    -- attributed to an account, and the thread has nowhere to hang.
    JOIN "WabaPhoneNumber" p ON p."phoneNumberId" = m."phoneNumberId"

    UNION ALL

    SELECT
        wo."ssoOrgId",
        i."wabaId",
        i."phoneNumberId",
        regexp_replace(i."from", '[^0-9]', '', 'g'),
        i."senderName",
        i."timestamp",
        'inbound'::"ConversationDirection",
        CASE i."type"
            WHEN 'text'     THEN i."payload"->>'body'
            WHEN 'image'    THEN 'Sent a photo'
            WHEN 'video'    THEN 'Sent a video'
            WHEN 'audio'    THEN 'Sent a voice message'
            WHEN 'document' THEN 'Sent a document'
            WHEN 'sticker'  THEN 'Sent a sticker'
            WHEN 'location' THEN 'Shared a location'
            WHEN 'contacts' THEN 'Shared a contact'
            WHEN 'reaction' THEN 'Reacted to a message'
            ELSE 'Sent a message'
        END
    FROM "InboundMessage" i
    -- One row per organisation holding the account, matching how the
    -- notification feed fans the same reply out.
    JOIN "WabaOrganisation" wo ON wo."wabaId" = i."wabaId"
)
INSERT INTO "Conversation" (
    "ssoOrgId", "wabaId", "phoneNumberId", "contactPhone", "contactName",
    "lastMessageAt", "lastDirection", "lastPreview", "lastInboundAt",
    "unreadCount", "lastReadAt", "status", "createdAt", "updatedAt"
)
SELECT
    sso_org_id,
    MIN(waba_id),
    phone_number_id,
    contact_phone,
    (ARRAY_REMOVE(ARRAY_AGG(contact_name ORDER BY at DESC), NULL))[1],
    MAX(at),
    (ARRAY_AGG(direction ORDER BY at DESC))[1],
    (ARRAY_AGG(preview ORDER BY at DESC))[1],
    MAX(at) FILTER (WHERE direction = 'inbound'),
    -- History is backfilled as read. The alternative is every existing
    -- customer opening the inbox to a badge counting years of replies nobody
    -- was ever shown, which is noise, not a to-do list.
    0,
    MAX(at),
    'open',
    MIN(at),
    MAX(at)
FROM events
WHERE contact_phone <> ''
GROUP BY sso_org_id, phone_number_id, contact_phone;
