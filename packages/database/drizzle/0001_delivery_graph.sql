ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "current_iteration" integer DEFAULT 1 NOT NULL;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "preview_url" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

CREATE TABLE IF NOT EXISTS "project_iterations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "number" integer NOT NULL,
  "objective" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_iteration_number" ON "project_iterations" ("project_id", "number");

CREATE TABLE IF NOT EXISTS "project_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_number" integer,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "agent_role" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "project_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid NOT NULL REFERENCES "project_iterations"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "name" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "content" text NOT NULL,
  "mime_type" text DEFAULT 'text/markdown' NOT NULL,
  "status" text DEFAULT 'ready_for_review' NOT NULL,
  "produced_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reviewed_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "project_media" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "url" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
