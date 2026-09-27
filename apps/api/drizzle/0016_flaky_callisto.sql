CREATE TABLE "report_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_sheet_id" integer NOT NULL,
	"plan_sheet_line_id" integer NOT NULL,
	"route_seq" integer NOT NULL,
	"process_name" text,
	"quantity" integer NOT NULL,
	"is_last" boolean DEFAULT false NOT NULL,
	"operator_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_slips" ADD COLUMN "operator_id" integer;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "operator_id" integer;--> statement-breakpoint
ALTER TABLE "incoming_goods" ADD COLUMN "operator_id" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "operator_id" integer;--> statement-breakpoint
ALTER TABLE "outbounds" ADD COLUMN "operator_id" integer;--> statement-breakpoint
ALTER TABLE "payment_slips" ADD COLUMN "operator_id" integer;--> statement-breakpoint
ALTER TABLE "stocktakes" ADD COLUMN "operator_id" integer;--> statement-breakpoint
ALTER TABLE "report_logs" ADD CONSTRAINT "report_logs_plan_sheet_id_plan_sheets_id_fk" FOREIGN KEY ("plan_sheet_id") REFERENCES "public"."plan_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_logs" ADD CONSTRAINT "report_logs_plan_sheet_line_id_plan_sheet_lines_id_fk" FOREIGN KEY ("plan_sheet_line_id") REFERENCES "public"."plan_sheet_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_logs" ADD CONSTRAINT "report_logs_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_slips" ADD CONSTRAINT "collection_slips_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_goods" ADD CONSTRAINT "incoming_goods_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbounds" ADD CONSTRAINT "outbounds_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;