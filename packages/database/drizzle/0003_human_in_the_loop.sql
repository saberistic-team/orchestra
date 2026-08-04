CREATE TABLE IF NOT EXISTS "agent_questions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "agent_role" text NOT NULL,
  "question" text NOT NULL,
  "context" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "allow_custom_answer" boolean DEFAULT true NOT NULL,
  "allow_agent_decide" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_questions_role_check" CHECK ("agent_role" IN (
    'manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security',
    'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation'
  )),
  CONSTRAINT "agent_questions_status_check" CHECK ("status" IN ('pending', 'answered', 'dismissed'))
);

CREATE TABLE IF NOT EXISTS "agent_question_options" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "question_id" uuid NOT NULL REFERENCES "agent_questions"("id") ON DELETE CASCADE,
  "value" text NOT NULL,
  "label" text NOT NULL,
  "description" text,
  "position" integer NOT NULL,
  CONSTRAINT "agent_question_option_position_check" CHECK ("position" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_question_option_value"
  ON "agent_question_options" ("question_id", "value");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_question_option_position"
  ON "agent_question_options" ("question_id", "position");

CREATE TABLE IF NOT EXISTS "agent_question_answers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "question_id" uuid NOT NULL REFERENCES "agent_questions"("id") ON DELETE CASCADE,
  "resolution" text NOT NULL,
  "option_id" uuid REFERENCES "agent_question_options"("id") ON DELETE SET NULL,
  "answer" text,
  "answered_by" text DEFAULT 'human' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_question_answer_resolution_check"
    CHECK ("resolution" IN ('selected_option', 'custom', 'agent_decides')),
  CONSTRAINT "agent_question_answer_actor_check" CHECK ("answered_by" IN ('human', 'agent')),
  CONSTRAINT "agent_question_answer_shape" CHECK (
    ("resolution" = 'selected_option' AND "option_id" IS NOT NULL AND "answer" IS NULL)
    OR ("resolution" = 'custom' AND "option_id" IS NULL AND length("answer") > 0)
    OR ("resolution" = 'agent_decides' AND "option_id" IS NULL AND "answer" IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_question_one_answer"
  ON "agent_question_answers" ("question_id");

CREATE OR REPLACE FUNCTION validate_agent_question_answer()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resolution = 'selected_option' AND NOT EXISTS (
    SELECT 1 FROM agent_question_options
    WHERE id = NEW.option_id AND question_id = NEW.question_id
  ) THEN
    RAISE EXCEPTION 'Selected option must belong to the answered question';
  END IF;

  IF NEW.resolution = 'custom' AND NOT EXISTS (
    SELECT 1 FROM agent_questions
    WHERE id = NEW.question_id AND allow_custom_answer = true
  ) THEN
    RAISE EXCEPTION 'This question does not allow a custom answer';
  END IF;

  IF NEW.resolution = 'agent_decides' AND NOT EXISTS (
    SELECT 1 FROM agent_questions
    WHERE id = NEW.question_id AND allow_agent_decide = true
  ) THEN
    RAISE EXCEPTION 'This question does not allow the agent to decide';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "validate_agent_question_answer_trigger"
  BEFORE INSERT OR UPDATE ON "agent_question_answers"
  FOR EACH ROW EXECUTE FUNCTION validate_agent_question_answer();

CREATE OR REPLACE FUNCTION enforce_agent_question_options()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  question_identifier uuid;
BEGIN
  IF TG_TABLE_NAME = 'agent_questions' THEN
    question_identifier := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    question_identifier := OLD.question_id;
  ELSE
    question_identifier := NEW.question_id;
  END IF;

  IF EXISTS (SELECT 1 FROM agent_questions WHERE id = question_identifier)
    AND (SELECT count(*) FROM agent_question_options WHERE question_id = question_identifier) < 1
  THEN
    RAISE EXCEPTION 'Every agent question must have at least one option';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "agent_question_requires_options"
  AFTER INSERT OR UPDATE ON "agent_questions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_agent_question_options();

CREATE CONSTRAINT TRIGGER "agent_question_options_cannot_be_emptied"
  AFTER INSERT OR UPDATE OR DELETE ON "agent_question_options"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_agent_question_options();

CREATE TABLE IF NOT EXISTS "agent_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "agent_role" text NOT NULL,
  "body" text NOT NULL,
  "author_type" text DEFAULT 'human' NOT NULL,
  "author_role" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_comments_role_check" CHECK ("agent_role" IN (
    'manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security',
    'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation'
  )),
  CONSTRAINT "agent_comments_author_type_check" CHECK ("author_type" IN ('human', 'agent', 'system')),
  CONSTRAINT "agent_comments_author_role_check" CHECK (
    "author_role" IS NULL OR "author_role" IN (
      'manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security',
      'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation'
    )
  )
);

CREATE TABLE IF NOT EXISTS "iteration_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid NOT NULL REFERENCES "project_iterations"("id") ON DELETE CASCADE,
  "iteration_number" integer NOT NULL,
  "decision" text NOT NULL,
  "feedback" text DEFAULT '' NOT NULL,
  "overall_direction" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "iteration_reviews_decision_check" CHECK ("decision" IN ('approve', 'request_changes')),
  CONSTRAINT "iteration_reviews_number_check" CHECK ("iteration_number" > 0)
);

CREATE TABLE IF NOT EXISTS "iteration_agent_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "review_id" uuid NOT NULL REFERENCES "iteration_reviews"("id") ON DELETE CASCADE,
  "agent_role" text NOT NULL,
  "feedback" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "iteration_agent_feedback_role_check" CHECK ("agent_role" IN (
    'manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security',
    'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation'
  ))
);
CREATE UNIQUE INDEX IF NOT EXISTS "iteration_review_agent_role"
  ON "iteration_agent_feedback" ("review_id", "agent_role");

CREATE OR REPLACE FUNCTION enforce_complete_iteration_agent_feedback()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  review_identifier uuid;
BEGIN
  IF TG_TABLE_NAME = 'iteration_reviews' THEN
    review_identifier := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    review_identifier := OLD.review_id;
  ELSE
    review_identifier := NEW.review_id;
  END IF;

  IF EXISTS (SELECT 1 FROM iteration_reviews WHERE id = review_identifier)
    AND (SELECT count(*) FROM iteration_agent_feedback WHERE review_id = review_identifier) <> 14
  THEN
    RAISE EXCEPTION 'Every iteration review must contain exactly one feedback value for all 14 agents';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "iteration_review_feedback_complete"
  AFTER INSERT OR UPDATE ON "iteration_reviews"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_complete_iteration_agent_feedback();

CREATE CONSTRAINT TRIGGER "iteration_review_feedback_stays_complete"
  AFTER INSERT OR UPDATE OR DELETE ON "iteration_agent_feedback"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_complete_iteration_agent_feedback();

CREATE TABLE IF NOT EXISTS "artifact_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid NOT NULL REFERENCES "project_iterations"("id") ON DELETE CASCADE,
  "artifact_id" uuid NOT NULL REFERENCES "project_artifacts"("id") ON DELETE CASCADE,
  "review_id" uuid REFERENCES "iteration_reviews"("id") ON DELETE SET NULL,
  "feedback" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "repository_lifecycle_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "iteration_id" uuid REFERENCES "project_iterations"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "repository_url" text,
  "external_id" text,
  "summary" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "repository_lifecycle_kind_check" CHECK ("kind" IN (
    'repository_connected', 'issue_created', 'branch_created', 'pull_request_opened',
    'pull_request_updated', 'review_recorded', 'pull_request_merged', 'deployment_started',
    'deployment_completed', 'repository_archived', 'operation_failed'
  )),
  CONSTRAINT "repository_lifecycle_status_check" CHECK ("status" IN ('pending', 'completed', 'failed'))
);

