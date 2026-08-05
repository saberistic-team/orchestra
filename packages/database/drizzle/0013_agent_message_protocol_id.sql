ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "protocol_message_id" text;

UPDATE "agent_messages"
SET "protocol_message_id" = "id"::text
WHERE "protocol_message_id" IS NULL;

ALTER TABLE "agent_messages" ALTER COLUMN "protocol_message_id" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_message_protocol_id"
  ON "agent_messages" ("project_id", "protocol_message_id");
