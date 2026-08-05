ALTER TABLE "project_artifacts" ADD COLUMN IF NOT EXISTS "operation_payload" jsonb;
ALTER TABLE "project_artifacts" ADD COLUMN IF NOT EXISTS "storage_mode" text NOT NULL DEFAULT 'repository';
UPDATE "project_artifacts" AS artifact
SET "storage_mode" = 'ledger'
WHERE EXISTS (
  SELECT 1
  FROM "artifact_versions" AS version
  WHERE version."artifact_id" = artifact."id"
    AND version."source_revision" IS NOT NULL
    AND version."storage_uri" IS NULL
);
