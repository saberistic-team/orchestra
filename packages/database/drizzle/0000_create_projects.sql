CREATE TABLE IF NOT EXISTS "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"intent" text NOT NULL,
	"audience" text NOT NULL,
	"success" text NOT NULL,
	"constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'discovering' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

