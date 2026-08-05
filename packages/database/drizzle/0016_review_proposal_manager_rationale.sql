ALTER TABLE "iteration_review_proposals" ADD COLUMN "manager_rationale" text;
UPDATE "iteration_review_proposals"
SET "manager_rationale" = "gate_rationale"
WHERE "manager_rationale" IS NULL;
