ALTER TABLE "iteration_review_proposals"
  DROP CONSTRAINT IF EXISTS "iteration_review_proposal_objective_check";

UPDATE "iteration_review_proposals"
SET "objective_status" = 'unsatisfied'
WHERE "objective_status" = 'not_satisfied';

ALTER TABLE "iteration_review_proposals"
  ADD CONSTRAINT "iteration_review_proposal_objective_check"
  CHECK ("objective_status" IN ('unsatisfied', 'partially_satisfied', 'satisfied', 'satisfied_with_known_gaps'));
