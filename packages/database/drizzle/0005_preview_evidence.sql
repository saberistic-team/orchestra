ALTER TABLE "project_media" ADD COLUMN IF NOT EXISTS "source_revision" text;
ALTER TABLE "project_media" ADD COLUMN IF NOT EXISTS "image_digest" text;
ALTER TABLE "project_media" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;

ALTER TABLE "iteration_reviews" ADD COLUMN IF NOT EXISTS "preview_revision" text;
ALTER TABLE "iteration_reviews" ADD COLUMN IF NOT EXISTS "preview_tried_at" timestamp with time zone;

ALTER TABLE "iteration_reviews"
  ADD CONSTRAINT "iteration_review_preview_attestation_shape"
  CHECK (
    ("preview_revision" IS NULL AND "preview_tried_at" IS NULL)
    OR ("preview_revision" IS NOT NULL AND "preview_tried_at" IS NOT NULL)
  );
