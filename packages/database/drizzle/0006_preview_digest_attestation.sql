ALTER TABLE "iteration_reviews" ADD COLUMN IF NOT EXISTS "preview_image_digest" text;

UPDATE "iteration_reviews" AS "review"
SET "preview_image_digest" = "evidence"."image_digest"
FROM (
  SELECT DISTINCT ON ("project_id", "iteration_id", "source_revision")
    "project_id",
    "iteration_id",
    "source_revision",
    "image_digest"
  FROM "project_media"
  WHERE "kind" = 'preview'
    AND "source_revision" IS NOT NULL
    AND "image_digest" IS NOT NULL
  ORDER BY "project_id", "iteration_id", "source_revision", "created_at" DESC
) AS "evidence"
WHERE "review"."project_id" = "evidence"."project_id"
  AND "review"."iteration_id" = "evidence"."iteration_id"
  AND "review"."preview_revision" = "evidence"."source_revision"
  AND "review"."preview_image_digest" IS NULL;

ALTER TABLE "iteration_reviews"
  DROP CONSTRAINT IF EXISTS "iteration_review_preview_attestation_shape";

-- The digest remains nullable only for Temporal histories that emitted a
-- revision-only attestation before the digest patch. New API submissions and
-- new checkpoints require all three fields in the application contract.
ALTER TABLE "iteration_reviews"
  ADD CONSTRAINT "iteration_review_preview_attestation_shape_v2"
  CHECK (
    ("preview_revision" IS NULL AND "preview_image_digest" IS NULL AND "preview_tried_at" IS NULL)
    OR ("preview_revision" IS NOT NULL AND "preview_tried_at" IS NOT NULL)
  );
