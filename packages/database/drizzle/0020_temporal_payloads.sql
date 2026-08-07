CREATE TABLE IF NOT EXISTS "temporal_payloads" (
  "hash_sha256" text PRIMARY KEY,
  "payload" bytea NOT NULL,
  "size_bytes" integer NOT NULL,
  "namespace" text,
  "target_kind" text,
  "target_type" text,
  "target_id" text,
  "run_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "temporal_payloads_created_at" ON "temporal_payloads" ("created_at");
