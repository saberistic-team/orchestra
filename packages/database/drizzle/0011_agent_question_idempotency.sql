ALTER TABLE "agent_questions" ADD COLUMN "operation_key" text;
CREATE UNIQUE INDEX "agent_question_operation_key"
  ON "agent_questions" ("project_id", "operation_key");
