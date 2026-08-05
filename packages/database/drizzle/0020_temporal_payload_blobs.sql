CREATE TABLE IF NOT EXISTS "temporal_payload_blobs" (
	"digest" text PRIMARY KEY NOT NULL,
	"data_base64" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"byte_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "temporal_payload_blobs_byte_length_nonnegative" CHECK ("temporal_payload_blobs"."byte_length" >= 0)
);
