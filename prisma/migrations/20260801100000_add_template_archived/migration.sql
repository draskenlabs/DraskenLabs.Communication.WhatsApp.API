-- Meta auto-archives a template after 12 months without activity — creating,
-- editing, sending, appealing or unarchiving it all count. Archived templates
-- cannot be sent, and Meta deletes them 28 days later unless they are
-- unarchived, which restores the previous status.
--
-- The status arrives on the message_template_status_update webhook, so without
-- this value the event is logged as unknown and the template silently keeps
-- showing as APPROVED while sends fail.
ALTER TYPE "TemplateStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';
