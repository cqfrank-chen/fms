CREATE TABLE "ai_parse_drafts" (
	"id" integer PRIMARY KEY NOT NULL,
	"result" jsonb NOT NULL,
	"draft" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
