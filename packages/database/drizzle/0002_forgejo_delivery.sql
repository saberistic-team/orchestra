ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "repository_url" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "repository_owner" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "repository_name" text;

ALTER TABLE "project_iterations" ADD COLUMN IF NOT EXISTS "issue_number" integer;
ALTER TABLE "project_iterations" ADD COLUMN IF NOT EXISTS "branch_name" text;
ALTER TABLE "project_iterations" ADD COLUMN IF NOT EXISTS "pull_request_number" integer;
ALTER TABLE "project_iterations" ADD COLUMN IF NOT EXISTS "pull_request_url" text;

ALTER TABLE "project_artifacts" ADD COLUMN IF NOT EXISTS "repository_path" text;
ALTER TABLE "project_artifacts" ADD COLUMN IF NOT EXISTS "repository_url" text;
ALTER TABLE "project_artifacts" ADD COLUMN IF NOT EXISTS "model" text;
