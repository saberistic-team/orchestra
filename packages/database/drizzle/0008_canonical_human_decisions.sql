ALTER TABLE "agent_questions" ADD COLUMN IF NOT EXISTS "decision_key" text;
ALTER TABLE "agent_questions" ADD COLUMN IF NOT EXISTS "reused_from_question_id" uuid;

ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_reused_from_fk"
  FOREIGN KEY ("reused_from_question_id") REFERENCES "agent_questions"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "agent_questions_project_decision_key"
  ON "agent_questions" ("project_id", "decision_key");

UPDATE "agent_questions"
SET "decision_key" = CASE
  WHEN lower("question") LIKE '%wcag%' THEN 'accessibility.wcag_baseline'
  WHEN lower("question") LIKE '%severity%' THEN 'findings.severity_taxonomy'
  WHEN lower("question") LIKE '%evidence%' AND (
    lower("question") LIKE '%protect%'
    OR lower("question") LIKE '%storage%'
  ) THEN 'security.evidence_protection'
  ELSE 'legacy.' || replace("id"::text, '-', '')
END
WHERE "decision_key" IS NULL;
