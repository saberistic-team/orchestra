ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "forgejo_project_id" integer;

CREATE TABLE IF NOT EXISTS "iteration_work_issues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "iteration_id" uuid NOT NULL REFERENCES "project_iterations"("id") ON DELETE cascade,
  "issue_number" integer NOT NULL,
  "package_key" text,
  "title" text NOT NULL,
  "created_by_role" text NOT NULL,
  "parent_issue_number" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "iteration_work_issue_number"
  ON "iteration_work_issues" ("iteration_id", "issue_number");
CREATE UNIQUE INDEX IF NOT EXISTS "iteration_work_issue_package_key"
  ON "iteration_work_issues" ("iteration_id", "package_key")
  WHERE "package_key" IS NOT NULL;
