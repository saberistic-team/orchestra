ALTER TABLE "project_artifacts" ADD COLUMN IF NOT EXISTS "operation_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "project_artifact_operation_key"
  ON "project_artifacts" ("project_id", "operation_key");
