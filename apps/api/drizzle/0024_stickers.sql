CREATE TABLE "sticker_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"sticker_id" integer NOT NULL,
	"kind" text NOT NULL,
	"qty_before" integer NOT NULL,
	"qty_delta" integer NOT NULL,
	"qty_after" integer NOT NULL,
	"remark" text,
	"operator_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stickers" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"brand" text,
	"style" text,
	"size_spec" text,
	"qty" integer DEFAULT 0 NOT NULL,
	"unit" text DEFAULT '张' NOT NULL,
	"customer" text,
	"image_path" text,
	"raw_text" text,
	"remark" text,
	"operator_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sticker_adjustments" ADD CONSTRAINT "sticker_adjustments_sticker_id_stickers_id_fk" FOREIGN KEY ("sticker_id") REFERENCES "public"."stickers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sticker_adjustments" ADD CONSTRAINT "sticker_adjustments_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stickers" ADD CONSTRAINT "stickers_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;