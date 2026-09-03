CREATE TYPE "public"."plan_status" AS ENUM('draft', 'confirmed', 'production', 'completed', 'voided');--> statement-breakpoint
CREATE TABLE "plan_sheet_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_sheet_id" integer NOT NULL,
	"order_line_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"completed_quantity" integer DEFAULT 0 NOT NULL,
	"engraving" text,
	"packaging" jsonb
);
--> statement-breakpoint
CREATE TABLE "plan_sheets" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_no" text NOT NULL,
	"order_id" integer NOT NULL,
	"status" "plan_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_sheets_plan_no_unique" UNIQUE("plan_no")
);
--> statement-breakpoint
ALTER TABLE "plan_sheet_lines" ADD CONSTRAINT "plan_sheet_lines_plan_sheet_id_plan_sheets_id_fk" FOREIGN KEY ("plan_sheet_id") REFERENCES "public"."plan_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_sheet_lines" ADD CONSTRAINT "plan_sheet_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_sheet_lines" ADD CONSTRAINT "plan_sheet_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_sheets" ADD CONSTRAINT "plan_sheets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;