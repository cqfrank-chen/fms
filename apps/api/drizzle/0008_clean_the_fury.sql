CREATE TABLE "ai_parse_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"parsed" jsonb NOT NULL,
	"corrected" jsonb,
	"corrections" jsonb,
	"direct_pass" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
