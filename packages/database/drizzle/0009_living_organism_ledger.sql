CREATE TABLE IF NOT EXISTS "agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "workflow_id" text NOT NULL,
  "instance_id" text,
  "lifecycle_status" text DEFAULT 'active' NOT NULL,
  "subscriptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agents_role_check" CHECK ("role" IN (
    'manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security',
    'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation'
  )),
  CONSTRAINT "agents_lifecycle_status_check" CHECK ("lifecycle_status" IN ('active', 'paused', 'retired')),
  CONSTRAINT "agents_subscriptions_array_check" CHECK (jsonb_typeof("subscriptions") = 'array'),
  CONSTRAINT "agents_metadata_object_check" CHECK (jsonb_typeof("metadata") = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS "agents_project_role" ON "agents" ("project_id", "role");
CREATE UNIQUE INDEX IF NOT EXISTS "agents_project_workflow" ON "agents" ("project_id", "workflow_id");
CREATE INDEX IF NOT EXISTS "agents_project_lifecycle" ON "agents" ("project_id", "lifecycle_status");

WITH "organism_roles"("role") AS (
  VALUES
    ('manager'), ('requirements'), ('product'), ('ux'), ('architecture'), ('data'), ('security'),
    ('planner'), ('builder'), ('test'), ('reviewer'), ('gate'), ('deployment'), ('validation')
)
INSERT INTO "agents" ("project_id", "role", "workflow_id")
SELECT
  "projects"."id",
  "organism_roles"."role",
  'project/' || "projects"."id"::text || '/agent/' || "organism_roles"."role"
FROM "projects"
CROSS JOIN "organism_roles"
ON CONFLICT ("project_id", "role") DO NOTHING;

CREATE TABLE IF NOT EXISTS "agent_runtime_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "state" text NOT NULL,
  "state_version" integer NOT NULL,
  "activity_type" text,
  "activity_summary" text,
  "waiting_reason" text,
  "blocker_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "model_provider" text,
  "model" text,
  "workflow_run_id" text,
  "correlation_id" text,
  "operation_key" text,
  "entered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "exited_at" timestamp with time zone,
  CONSTRAINT "agent_runtime_state_kind_check" CHECK ("state" IN (
    'observing', 'ready', 'planning', 'working', 'reviewing', 'communicating',
    'waiting_on_agent', 'waiting_on_human', 'monitoring', 'blocked', 'completed_for_iteration'
  )),
  CONSTRAINT "agent_runtime_state_version_check" CHECK ("state_version" >= 0),
  CONSTRAINT "agent_runtime_state_time_check" CHECK ("exited_at" IS NULL OR "exited_at" >= "entered_at"),
  CONSTRAINT "agent_runtime_state_blockers_array_check" CHECK (jsonb_typeof("blocker_references") = 'array')
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runtime_state_version"
  ON "agent_runtime_states" ("agent_id", "state_version");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runtime_state_current"
  ON "agent_runtime_states" ("agent_id") WHERE "exited_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runtime_state_operation_key"
  ON "agent_runtime_states" ("project_id", "operation_key");
CREATE INDEX IF NOT EXISTS "agent_runtime_state_project_iteration"
  ON "agent_runtime_states" ("project_id", "iteration_id", "entered_at");
CREATE INDEX IF NOT EXISTS "agent_runtime_state_correlation"
  ON "agent_runtime_states" ("project_id", "correlation_id");

CREATE TABLE IF NOT EXISTS "agent_goals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "objective" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "priority" text DEFAULT 'normal' NOT NULL,
  "success_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "correlation_id" text,
  "operation_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "agent_goal_status_check" CHECK ("status" IN ('active', 'satisfied', 'blocked', 'abandoned', 'superseded')),
  CONSTRAINT "agent_goal_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'critical')),
  CONSTRAINT "agent_goal_success_criteria_array_check" CHECK (jsonb_typeof("success_criteria") = 'array'),
  CONSTRAINT "agent_goal_time_check" CHECK ("completed_at" IS NULL OR "completed_at" >= "created_at")
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_goal_operation_key" ON "agent_goals" ("project_id", "operation_key");
CREATE INDEX IF NOT EXISTS "agent_goal_agent_status" ON "agent_goals" ("agent_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "agent_goal_iteration_status" ON "agent_goals" ("project_id", "iteration_id", "status");

CREATE TABLE IF NOT EXISTS "agent_action_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "goal_id" uuid REFERENCES "agent_goals"("id") ON DELETE SET NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "summary" text NOT NULL,
  "rationale" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "source_revision" text,
  "correlation_id" text,
  "operation_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "agent_action_plan_version_check" CHECK ("version" > 0),
  CONSTRAINT "agent_action_plan_status_check" CHECK ("status" IN ('draft', 'active', 'completed', 'blocked', 'superseded', 'cancelled')),
  CONSTRAINT "agent_action_plan_time_check" CHECK ("completed_at" IS NULL OR "completed_at" >= "created_at")
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_action_plan_goal_version" ON "agent_action_plans" ("goal_id", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_action_plan_operation_key" ON "agent_action_plans" ("project_id", "operation_key");
CREATE INDEX IF NOT EXISTS "agent_action_plan_agent_status" ON "agent_action_plans" ("agent_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "agent_action_plan_iteration_status" ON "agent_action_plans" ("project_id", "iteration_id", "status");

CREATE TABLE IF NOT EXISTS "agent_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "plan_id" uuid REFERENCES "agent_action_plans"("id") ON DELETE SET NULL,
  "position" integer NOT NULL,
  "kind" text NOT NULL,
  "summary" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "blocking" boolean DEFAULT false NOT NULL,
  "dependency_action_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "input" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "output" jsonb,
  "error" text,
  "correlation_id" text,
  "operation_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "agent_action_position_check" CHECK ("position" >= 0),
  CONSTRAINT "agent_action_status_check" CHECK ("status" IN ('pending', 'ready', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'superseded')),
  CONSTRAINT "agent_action_dependencies_array_check" CHECK (jsonb_typeof("dependency_action_ids") = 'array'),
  CONSTRAINT "agent_action_input_object_check" CHECK (jsonb_typeof("input") = 'object'),
  CONSTRAINT "agent_action_output_object_check" CHECK ("output" IS NULL OR jsonb_typeof("output") = 'object'),
  CONSTRAINT "agent_action_time_check" CHECK (
    "completed_at" IS NULL OR ("started_at" IS NOT NULL AND "completed_at" >= "started_at")
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_action_plan_position" ON "agent_actions" ("plan_id", "position");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_action_operation_key" ON "agent_actions" ("project_id", "operation_key");
CREATE INDEX IF NOT EXISTS "agent_action_agent_status" ON "agent_actions" ("agent_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "agent_action_iteration_status" ON "agent_actions" ("project_id", "iteration_id", "status");
CREATE INDEX IF NOT EXISTS "agent_action_correlation" ON "agent_actions" ("project_id", "correlation_id");

CREATE TABLE IF NOT EXISTS "message_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "correlation_id" text NOT NULL,
  "topic" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "max_response_depth" integer DEFAULT 8 NOT NULL,
  "response_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_message_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "message_thread_status_check" CHECK ("status" IN ('open', 'resolved', 'archived')),
  CONSTRAINT "message_thread_depth_check" CHECK ("max_response_depth" > 0 AND "response_count" >= 0),
  CONSTRAINT "message_thread_time_check" CHECK ("resolved_at" IS NULL OR "resolved_at" >= "created_at")
);
CREATE UNIQUE INDEX IF NOT EXISTS "message_thread_project_correlation"
  ON "message_threads" ("project_id", "correlation_id");
CREATE INDEX IF NOT EXISTS "message_thread_iteration_status"
  ON "message_threads" ("project_id", "iteration_id", "status", "updated_at");

CREATE TABLE IF NOT EXISTS "agent_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "thread_id" uuid NOT NULL REFERENCES "message_threads"("id") ON DELETE CASCADE,
  "sender_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "sender_role" text NOT NULL,
  "recipient_roles" jsonb NOT NULL,
  "type" text NOT NULL,
  "name" text NOT NULL,
  "summary" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "priority" text DEFAULT 'normal' NOT NULL,
  "correlation_id" text NOT NULL,
  "causation_message_id" uuid REFERENCES "agent_messages"("id") ON DELETE SET NULL,
  "response_depth" integer DEFAULT 0 NOT NULL,
  "idempotency_key" text NOT NULL,
  "requires_acknowledgement" boolean DEFAULT false NOT NULL,
  "delivery_states" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "artifact_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "delivered_at" timestamp with time zone,
  "acknowledged_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  CONSTRAINT "agent_message_sender_check" CHECK ("sender_role" IN (
    'manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security',
    'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation', 'human', 'system'
  )),
  CONSTRAINT "agent_message_recipients_check" CHECK (
    jsonb_typeof("recipient_roles") = 'array' AND jsonb_array_length("recipient_roles") > 0
  ),
  CONSTRAINT "agent_message_type_check" CHECK ("type" IN (
    'order', 'request', 'question', 'answer', 'finding', 'decision', 'handoff',
    'evidence', 'review', 'status', 'acknowledgement', 'blocker', 'revision_request', 'review_proposal'
  )),
  CONSTRAINT "agent_message_status_check" CHECK ("status" IN ('pending', 'delivered', 'acknowledged', 'completed', 'failed', 'superseded')),
  CONSTRAINT "agent_message_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'critical')),
  CONSTRAINT "agent_message_response_depth_check" CHECK ("response_depth" >= 0),
  CONSTRAINT "agent_message_delivery_states_object_check" CHECK (jsonb_typeof("delivery_states") = 'object'),
  CONSTRAINT "agent_message_payload_object_check" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "agent_message_artifacts_array_check" CHECK (jsonb_typeof("artifact_references") = 'array'),
  CONSTRAINT "agent_message_time_check" CHECK (
    ("delivered_at" IS NULL OR "delivered_at" >= "created_at")
    AND ("acknowledged_at" IS NULL OR "acknowledged_at" >= "created_at")
    AND ("expires_at" IS NULL OR "expires_at" >= "created_at")
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_message_idempotency_key"
  ON "agent_messages" ("project_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "agent_message_thread_created" ON "agent_messages" ("thread_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_message_project_status" ON "agent_messages" ("project_id", "status", "available_at");
CREATE INDEX IF NOT EXISTS "agent_message_iteration_type" ON "agent_messages" ("project_id", "iteration_id", "type", "created_at");
CREATE INDEX IF NOT EXISTS "agent_message_sender_created" ON "agent_messages" ("sender_agent_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_message_correlation" ON "agent_messages" ("project_id", "correlation_id", "created_at");
CREATE INDEX IF NOT EXISTS "agent_message_recipients" ON "agent_messages" USING gin ("recipient_roles");

CREATE TABLE IF NOT EXISTS "agent_obligations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "owner_agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "goal_id" uuid REFERENCES "agent_goals"("id") ON DELETE SET NULL,
  "action_id" uuid REFERENCES "agent_actions"("id") ON DELETE SET NULL,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "priority" text DEFAULT 'normal' NOT NULL,
  "mandatory" boolean DEFAULT true NOT NULL,
  "blocking" boolean DEFAULT true NOT NULL,
  "subject_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "dependency_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "satisfaction_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "disposition" text,
  "source_revision" text,
  "correlation_id" text,
  "operation_key" text,
  "due_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "satisfied_at" timestamp with time zone,
  CONSTRAINT "agent_obligation_status_check" CHECK ("status" IN ('pending', 'ready', 'in_progress', 'blocked', 'satisfied', 'waived', 'deferred', 'failed')),
  CONSTRAINT "agent_obligation_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'critical')),
  CONSTRAINT "agent_obligation_subjects_array_check" CHECK (jsonb_typeof("subject_references") = 'array'),
  CONSTRAINT "agent_obligation_dependencies_array_check" CHECK (jsonb_typeof("dependency_references") = 'array'),
  CONSTRAINT "agent_obligation_evidence_array_check" CHECK (jsonb_typeof("satisfaction_evidence") = 'array'),
  CONSTRAINT "agent_obligation_time_check" CHECK ("satisfied_at" IS NULL OR "satisfied_at" >= "created_at")
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_obligation_operation_key"
  ON "agent_obligations" ("project_id", "operation_key");
CREATE INDEX IF NOT EXISTS "agent_obligation_iteration_status"
  ON "agent_obligations" ("project_id", "iteration_id", "status", "blocking");
CREATE INDEX IF NOT EXISTS "agent_obligation_owner_status"
  ON "agent_obligations" ("owner_agent_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "agent_obligation_revision"
  ON "agent_obligations" ("project_id", "source_revision");

CREATE TABLE IF NOT EXISTS "artifact_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid NOT NULL REFERENCES "project_iterations"("id") ON DELETE CASCADE,
  "artifact_id" uuid NOT NULL REFERENCES "project_artifacts"("id") ON DELETE CASCADE,
  "produced_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "version" integer NOT NULL,
  "status" text NOT NULL,
  "content" text NOT NULL,
  "mime_type" text DEFAULT 'text/markdown' NOT NULL,
  "content_hash" text,
  "storage_uri" text,
  "repository_path" text,
  "source_revision" text,
  "supersedes_version_id" uuid REFERENCES "artifact_versions"("id") ON DELETE SET NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "operation_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "artifact_version_number_check" CHECK ("version" > 0),
  CONSTRAINT "artifact_version_status_check" CHECK ("status" IN ('draft', 'ready_for_review', 'changes_requested', 'approved', 'superseded')),
  CONSTRAINT "artifact_version_metadata_object_check" CHECK (jsonb_typeof("metadata") = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_version_number" ON "artifact_versions" ("artifact_id", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_version_operation_key" ON "artifact_versions" ("project_id", "operation_key");
CREATE INDEX IF NOT EXISTS "artifact_version_iteration_status" ON "artifact_versions" ("project_id", "iteration_id", "status");
CREATE INDEX IF NOT EXISTS "artifact_version_source_revision" ON "artifact_versions" ("project_id", "source_revision");
CREATE INDEX IF NOT EXISTS "artifact_version_content_hash" ON "artifact_versions" ("project_id", "content_hash");

INSERT INTO "artifact_versions" (
  "project_id",
  "iteration_id",
  "artifact_id",
  "produced_by_agent_id",
  "version",
  "status",
  "content",
  "mime_type",
  "repository_path",
  "metadata",
  "operation_key",
  "created_at"
)
SELECT
  "artifact"."project_id",
  "artifact"."iteration_id",
  "artifact"."id",
  "producer"."id",
  "artifact"."version",
  "artifact"."status",
  "artifact"."content",
  "artifact"."mime_type",
  "artifact"."repository_path",
  jsonb_strip_nulls(jsonb_build_object(
    'legacyProducedBy', "artifact"."produced_by",
    'legacyModel', "artifact"."model",
    'legacyModelProvider', "artifact"."model_provider",
    'legacyModelInvocations', "artifact"."model_invocations",
    'repositoryUrl', "artifact"."repository_url"
  )),
  'legacy-artifact:' || "artifact"."id"::text || ':v' || "artifact"."version"::text,
  "artifact"."created_at"
FROM "project_artifacts" AS "artifact"
LEFT JOIN "agents" AS "producer"
  ON "producer"."project_id" = "artifact"."project_id"
  AND "producer"."role" = "artifact"."produced_by"
ON CONFLICT ("artifact_id", "version") DO NOTHING;

CREATE TABLE IF NOT EXISTS "findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "raised_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "owner_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "obligation_id" uuid REFERENCES "agent_obligations"("id") ON DELETE SET NULL,
  "action_id" uuid REFERENCES "agent_actions"("id") ON DELETE SET NULL,
  "artifact_version_id" uuid REFERENCES "artifact_versions"("id") ON DELETE SET NULL,
  "category" text NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "severity" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "disposition" text,
  "subject_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "evidence_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "source_revision" text,
  "correlation_id" text,
  "operation_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "finding_severity_check" CHECK ("severity" IN ('critical', 'high', 'medium', 'low', 'info')),
  CONSTRAINT "finding_status_check" CHECK ("status" IN ('open', 'acknowledged', 'remediating', 'resolved', 'accepted_risk', 'dismissed')),
  CONSTRAINT "finding_disposition_check" CHECK (
    "disposition" IS NULL OR "disposition" IN ('block_iteration', 'remediate_current', 'defer_to_next_iteration', 'accepted_risk', 'not_applicable')
  ),
  CONSTRAINT "finding_subjects_array_check" CHECK (jsonb_typeof("subject_references") = 'array'),
  CONSTRAINT "finding_evidence_array_check" CHECK (jsonb_typeof("evidence_references") = 'array'),
  CONSTRAINT "finding_time_check" CHECK ("resolved_at" IS NULL OR "resolved_at" >= "created_at")
);
CREATE UNIQUE INDEX IF NOT EXISTS "finding_operation_key" ON "findings" ("project_id", "operation_key");
CREATE INDEX IF NOT EXISTS "finding_iteration_status_severity" ON "findings" ("project_id", "iteration_id", "status", "severity");
CREATE INDEX IF NOT EXISTS "finding_owner_status" ON "findings" ("owner_agent_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "finding_revision" ON "findings" ("project_id", "source_revision");
CREATE INDEX IF NOT EXISTS "finding_correlation" ON "findings" ("project_id", "correlation_id");

CREATE TABLE IF NOT EXISTS "human_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "question_id" uuid REFERENCES "agent_questions"("id") ON DELETE SET NULL,
  "review_id" uuid REFERENCES "iteration_reviews"("id") ON DELETE SET NULL,
  "decision_key" text NOT NULL,
  "decision_type" text NOT NULL,
  "selected_option" text NOT NULL,
  "rationale" text DEFAULT '' NOT NULL,
  "decided_by" text NOT NULL,
  "status" text DEFAULT 'recorded' NOT NULL,
  "options_considered" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "applies_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "authority" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "supersedes_decision_id" uuid REFERENCES "human_decisions"("id") ON DELETE SET NULL,
  "correlation_id" text,
  "operation_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "superseded_at" timestamp with time zone,
  CONSTRAINT "human_decision_status_check" CHECK ("status" IN ('recorded', 'superseded', 'revoked')),
  CONSTRAINT "human_decision_options_array_check" CHECK (jsonb_typeof("options_considered") = 'array'),
  CONSTRAINT "human_decision_applies_to_array_check" CHECK (jsonb_typeof("applies_to") = 'array'),
  CONSTRAINT "human_decision_authority_object_check" CHECK (jsonb_typeof("authority") = 'object'),
  CONSTRAINT "human_decision_time_check" CHECK ("superseded_at" IS NULL OR "superseded_at" >= "created_at")
);
CREATE UNIQUE INDEX IF NOT EXISTS "human_decision_operation_key" ON "human_decisions" ("project_id", "operation_key");
CREATE INDEX IF NOT EXISTS "human_decision_key_created" ON "human_decisions" ("project_id", "decision_key", "created_at");
CREATE INDEX IF NOT EXISTS "human_decision_iteration_status" ON "human_decisions" ("project_id", "iteration_id", "status");
CREATE INDEX IF NOT EXISTS "human_decision_correlation" ON "human_decisions" ("project_id", "correlation_id");

INSERT INTO "human_decisions" (
  "project_id",
  "iteration_id",
  "question_id",
  "decision_key",
  "decision_type",
  "selected_option",
  "rationale",
  "decided_by",
  "options_considered",
  "applies_to",
  "authority",
  "operation_key",
  "created_at"
)
SELECT
  "question"."project_id",
  "question"."iteration_id",
  "question"."id",
  "question"."decision_key",
  'question_answer',
  CASE "answer"."resolution"
    WHEN 'selected_option' THEN "selected_option"."value"
    WHEN 'custom' THEN "answer"."answer"
    ELSE 'agent_decides'
  END,
  COALESCE("question"."context", ''),
  "answer"."answered_by",
  COALESCE("options"."values", '[]'::jsonb),
  jsonb_build_array('question:' || "question"."id"::text),
  jsonb_build_object('source', 'agent_question_answer', 'resolution', "answer"."resolution"),
  'legacy-question-answer:' || "answer"."id"::text,
  "answer"."created_at"
FROM "agent_question_answers" AS "answer"
JOIN "agent_questions" AS "question" ON "question"."id" = "answer"."question_id"
LEFT JOIN "agent_question_options" AS "selected_option" ON "selected_option"."id" = "answer"."option_id"
LEFT JOIN LATERAL (
  SELECT jsonb_agg("option"."value" ORDER BY "option"."position") AS "values"
  FROM "agent_question_options" AS "option"
  WHERE "option"."question_id" = "question"."id"
) AS "options" ON true
ON CONFLICT ("project_id", "operation_key") DO NOTHING;

INSERT INTO "human_decisions" (
  "project_id",
  "iteration_id",
  "review_id",
  "decision_key",
  "decision_type",
  "selected_option",
  "rationale",
  "decided_by",
  "applies_to",
  "authority",
  "operation_key",
  "created_at"
)
SELECT
  "review"."project_id",
  "review"."iteration_id",
  "review"."id",
  'iteration.' || "review"."iteration_number"::text || '.review',
  'iteration_review',
  "review"."decision",
  concat_ws(E'\n\n', NULLIF("review"."feedback", ''), NULLIF("review"."overall_direction", '')),
  'human',
  jsonb_build_array('iteration:' || "review"."iteration_id"::text),
  jsonb_build_object('source', 'iteration_review'),
  'legacy-iteration-review:' || "review"."id"::text,
  "review"."created_at"
FROM "iteration_reviews" AS "review"
ON CONFLICT ("project_id", "operation_key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "human_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "decision_id" uuid REFERENCES "human_decisions"("id") ON DELETE SET NULL,
  "review_id" uuid REFERENCES "iteration_reviews"("id") ON DELETE SET NULL,
  "artifact_id" uuid REFERENCES "project_artifacts"("id") ON DELETE SET NULL,
  "artifact_version_id" uuid REFERENCES "artifact_versions"("id") ON DELETE SET NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "type" text NOT NULL,
  "body" text NOT NULL,
  "author_id" text,
  "status" text DEFAULT 'received' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "correlation_id" text,
  "operation_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "acknowledged_at" timestamp with time zone,
  "addressed_at" timestamp with time zone,
  CONSTRAINT "human_feedback_status_check" CHECK ("status" IN ('received', 'acknowledged', 'addressed', 'dismissed')),
  CONSTRAINT "human_feedback_metadata_object_check" CHECK (jsonb_typeof("metadata") = 'object'),
  CONSTRAINT "human_feedback_time_check" CHECK (
    ("acknowledged_at" IS NULL OR "acknowledged_at" >= "created_at")
    AND ("addressed_at" IS NULL OR "addressed_at" >= "created_at")
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "human_feedback_operation_key" ON "human_feedback" ("project_id", "operation_key");
CREATE INDEX IF NOT EXISTS "human_feedback_iteration_status" ON "human_feedback" ("project_id", "iteration_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "human_feedback_agent_status" ON "human_feedback" ("agent_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "human_feedback_correlation" ON "human_feedback" ("project_id", "correlation_id");

INSERT INTO "human_feedback" (
  "project_id",
  "iteration_id",
  "agent_id",
  "type",
  "body",
  "author_id",
  "metadata",
  "operation_key",
  "created_at"
)
SELECT
  "comment"."project_id",
  "comment"."iteration_id",
  "agent"."id",
  'agent_comment',
  "comment"."body",
  'human',
  jsonb_build_object('source', 'agent_comments', 'sourceId', "comment"."id"),
  'legacy-agent-comment:' || "comment"."id"::text,
  "comment"."created_at"
FROM "agent_comments" AS "comment"
LEFT JOIN "agents" AS "agent"
  ON "agent"."project_id" = "comment"."project_id"
  AND "agent"."role" = "comment"."agent_role"
WHERE "comment"."author_type" = 'human'
ON CONFLICT ("project_id", "operation_key") DO NOTHING;

INSERT INTO "human_feedback" (
  "project_id",
  "iteration_id",
  "review_id",
  "artifact_id",
  "artifact_version_id",
  "type",
  "body",
  "author_id",
  "metadata",
  "operation_key",
  "created_at"
)
SELECT
  "feedback"."project_id",
  "feedback"."iteration_id",
  "feedback"."review_id",
  "feedback"."artifact_id",
  "version"."id",
  'artifact_feedback',
  "feedback"."feedback",
  'human',
  jsonb_build_object('source', 'artifact_feedback', 'sourceId', "feedback"."id"),
  'legacy-artifact-feedback:' || "feedback"."id"::text,
  "feedback"."created_at"
FROM "artifact_feedback" AS "feedback"
LEFT JOIN "project_artifacts" AS "artifact" ON "artifact"."id" = "feedback"."artifact_id"
LEFT JOIN "artifact_versions" AS "version"
  ON "version"."artifact_id" = "feedback"."artifact_id"
  AND "version"."version" = "artifact"."version"
ON CONFLICT ("project_id", "operation_key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "model_invocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "action_id" uuid REFERENCES "agent_actions"("id") ON DELETE SET NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "purpose" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "external_request_id" text,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cached_tokens" integer DEFAULT 0 NOT NULL,
  "total_tokens" integer DEFAULT 0 NOT NULL,
  "cost_usd" numeric(18, 8) DEFAULT 0 NOT NULL,
  "request_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "response_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "correlation_id" text,
  "operation_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "model_invocation_provider_check" CHECK ("provider" IN ('ollama', 'openrouter')),
  CONSTRAINT "model_invocation_status_check" CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT "model_invocation_token_check" CHECK (
    "input_tokens" >= 0 AND "output_tokens" >= 0 AND "cached_tokens" >= 0 AND "total_tokens" >= 0
  ),
  CONSTRAINT "model_invocation_cost_check" CHECK ("cost_usd" >= 0),
  CONSTRAINT "model_invocation_request_metadata_check" CHECK (jsonb_typeof("request_metadata") = 'object'),
  CONSTRAINT "model_invocation_response_metadata_check" CHECK (jsonb_typeof("response_metadata") = 'object'),
  CONSTRAINT "model_invocation_time_check" CHECK (
    "completed_at" IS NULL OR ("started_at" IS NOT NULL AND "completed_at" >= "started_at")
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "model_invocation_operation_key" ON "model_invocations" ("project_id", "operation_key");
CREATE INDEX IF NOT EXISTS "model_invocation_agent_status" ON "model_invocations" ("agent_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "model_invocation_iteration_created" ON "model_invocations" ("project_id", "iteration_id", "created_at");
CREATE INDEX IF NOT EXISTS "model_invocation_external_request" ON "model_invocations" ("provider", "external_request_id");
CREATE INDEX IF NOT EXISTS "model_invocation_correlation" ON "model_invocations" ("project_id", "correlation_id");

CREATE TABLE IF NOT EXISTS "repository_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "action_id" uuid REFERENCES "agent_actions"("id") ON DELETE SET NULL,
  "lifecycle_record_id" uuid REFERENCES "repository_lifecycle_records"("id") ON DELETE SET NULL,
  "type" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "mutating" boolean DEFAULT false NOT NULL,
  "repository_url" text,
  "branch_name" text,
  "paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "expected_base_revision" text,
  "resulting_revision" text,
  "external_id" text,
  "summary" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "correlation_id" text,
  "operation_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "repository_operation_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'failed', 'conflicted', 'cancelled')),
  CONSTRAINT "repository_operation_paths_array_check" CHECK (jsonb_typeof("paths") = 'array'),
  CONSTRAINT "repository_operation_metadata_object_check" CHECK (jsonb_typeof("metadata") = 'object'),
  CONSTRAINT "repository_operation_time_check" CHECK (
    "completed_at" IS NULL OR ("started_at" IS NOT NULL AND "completed_at" >= "started_at")
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "repository_operation_operation_key"
  ON "repository_operations" ("project_id", "operation_key");
CREATE UNIQUE INDEX IF NOT EXISTS "repository_operation_running_mutation"
  ON "repository_operations" ("project_id", "branch_name")
  WHERE "mutating" = true AND "status" = 'running' AND "branch_name" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "repository_operation_iteration_status"
  ON "repository_operations" ("project_id", "iteration_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "repository_operation_agent_status"
  ON "repository_operations" ("agent_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "repository_operation_branch_status"
  ON "repository_operations" ("project_id", "branch_name", "status");
CREATE INDEX IF NOT EXISTS "repository_operation_base_revision"
  ON "repository_operations" ("project_id", "expected_base_revision");
CREATE INDEX IF NOT EXISTS "repository_operation_result_revision"
  ON "repository_operations" ("project_id", "resulting_revision");

-- repository_lifecycle_records remains the compatibility source used by the
-- current store. repository_operations is the canonical, revision-aware record
-- and keeps an explicit pointer back to that source during the transition.
INSERT INTO "repository_operations" (
  "project_id",
  "iteration_id",
  "lifecycle_record_id",
  "type",
  "status",
  "mutating",
  "repository_url",
  "external_id",
  "summary",
  "metadata",
  "operation_key",
  "created_at",
  "started_at",
  "completed_at"
)
SELECT
  "lifecycle"."project_id",
  "lifecycle"."iteration_id",
  "lifecycle"."id",
  "lifecycle"."kind",
  CASE "lifecycle"."status" WHEN 'pending' THEN 'queued' ELSE "lifecycle"."status" END,
  "lifecycle"."kind" IN (
    'branch_created', 'pull_request_opened', 'pull_request_updated', 'pull_request_merged',
    'deployment_started', 'deployment_completed', 'repository_archived'
  ),
  "lifecycle"."repository_url",
  "lifecycle"."external_id",
  "lifecycle"."summary",
  "lifecycle"."metadata" || jsonb_build_object('source', 'repository_lifecycle_records'),
  'legacy-repository-lifecycle:' || "lifecycle"."id"::text,
  "lifecycle"."created_at",
  "lifecycle"."created_at",
  CASE WHEN "lifecycle"."status" IN ('completed', 'failed') THEN "lifecycle"."created_at" END
FROM "repository_lifecycle_records" AS "lifecycle"
ON CONFLICT ("project_id", "operation_key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "iteration_review_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid NOT NULL REFERENCES "project_iterations"("id") ON DELETE CASCADE,
  "proposed_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "proposal_version" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "objective_status" text NOT NULL,
  "included_revision" text NOT NULL,
  "completed_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "open_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "agent_positions" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "gate_status" text NOT NULL,
  "gate_rationale" text,
  "recommendation" text NOT NULL,
  "known_limitations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "budget_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "correlation_id" text NOT NULL,
  "operation_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "iteration_review_proposal_version_check" CHECK ("proposal_version" > 0),
  CONSTRAINT "iteration_review_proposal_status_check" CHECK ("status" IN ('draft', 'proposed', 'gate_blocked', 'superseded', 'accepted', 'rejected')),
  CONSTRAINT "iteration_review_proposal_objective_check" CHECK ("objective_status" IN ('satisfied', 'satisfied_with_known_gaps', 'not_satisfied')),
  CONSTRAINT "iteration_review_proposal_gate_check" CHECK ("gate_status" IN ('pass', 'block', 'waiting')),
  CONSTRAINT "iteration_review_proposal_recommendation_check" CHECK (
    "recommendation" IN ('continue_iteration', 'send_for_human_review', 'reduce_scope', 'request_human_decision')
  ),
  CONSTRAINT "iteration_review_proposal_outcomes_array_check" CHECK (jsonb_typeof("completed_outcomes") = 'array'),
  CONSTRAINT "iteration_review_proposal_findings_array_check" CHECK (jsonb_typeof("open_findings") = 'array'),
  CONSTRAINT "iteration_review_proposal_positions_object_check" CHECK (jsonb_typeof("agent_positions") = 'object'),
  CONSTRAINT "iteration_review_proposal_limitations_array_check" CHECK (jsonb_typeof("known_limitations") = 'array'),
  CONSTRAINT "iteration_review_proposal_budget_object_check" CHECK (jsonb_typeof("budget_snapshot") = 'object'),
  CONSTRAINT "iteration_review_proposal_time_check" CHECK ("resolved_at" IS NULL OR "resolved_at" >= "created_at")
);
CREATE UNIQUE INDEX IF NOT EXISTS "iteration_review_proposal_version"
  ON "iteration_review_proposals" ("iteration_id", "included_revision", "proposal_version");
CREATE UNIQUE INDEX IF NOT EXISTS "iteration_review_proposal_operation_key"
  ON "iteration_review_proposals" ("project_id", "operation_key");
CREATE INDEX IF NOT EXISTS "iteration_review_proposal_status"
  ON "iteration_review_proposals" ("project_id", "iteration_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "iteration_review_proposal_revision"
  ON "iteration_review_proposals" ("project_id", "included_revision");
CREATE INDEX IF NOT EXISTS "iteration_review_proposal_correlation"
  ON "iteration_review_proposals" ("project_id", "correlation_id");
