ALTER TABLE "project_media" ADD COLUMN IF NOT EXISTS "operation_key" text;
CREATE UNIQUE INDEX IF NOT EXISTS "project_media_operation_key"
  ON "project_media" ("project_id", "operation_key");
