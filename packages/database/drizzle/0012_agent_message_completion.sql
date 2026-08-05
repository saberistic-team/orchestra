ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;

ALTER TABLE "agent_messages" DROP CONSTRAINT IF EXISTS "agent_message_time_check";
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_message_time_check" CHECK (
  ("delivered_at" IS NULL OR "delivered_at" >= "created_at")
  AND ("acknowledged_at" IS NULL OR "acknowledged_at" >= "created_at")
  AND ("completed_at" IS NULL OR "completed_at" >= "created_at")
  AND ("expires_at" IS NULL OR "expires_at" >= "created_at")
);
