-- AlterEnum
-- Meta's message_template_status_update webhook emits PAUSED (low-quality pause)
-- and PENDING_DELETION events that previously had no matching enum value.
ALTER TYPE "TemplateStatus" ADD VALUE IF NOT EXISTS 'PAUSED';
ALTER TYPE "TemplateStatus" ADD VALUE IF NOT EXISTS 'PENDING_DELETION';
