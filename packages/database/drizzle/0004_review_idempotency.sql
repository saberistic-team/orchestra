ALTER TABLE "project_events" ADD COLUMN IF NOT EXISTS "operation_key" text;
ALTER TABLE "iteration_reviews" ADD COLUMN IF NOT EXISTS "operation_key" text;
ALTER TABLE "repository_lifecycle_records" ADD COLUMN IF NOT EXISTS "operation_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "project_event_operation_key"
  ON "project_events" ("project_id", "operation_key");
CREATE UNIQUE INDEX IF NOT EXISTS "iteration_review_operation_key"
  ON "iteration_reviews" ("project_id", "operation_key");
CREATE UNIQUE INDEX IF NOT EXISTS "repository_lifecycle_operation_key"
  ON "repository_lifecycle_records" ("project_id", "operation_key");
