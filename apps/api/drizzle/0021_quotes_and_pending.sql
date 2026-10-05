CREATE TABLE "product_quotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer,
	"product_id" integer,
	"product_name" text,
	"unit_price_cents" bigint NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_file" text,
	"remark" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"operator_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "pending_items" jsonb;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "price_source" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "product_name_text" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "due_date_tbd" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "draft_customer_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pending_items" jsonb;--> statement-breakpoint
ALTER TABLE "product_quotes" ADD CONSTRAINT "product_quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_quotes" ADD CONSTRAINT "product_quotes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_quotes" ADD CONSTRAINT "product_quotes_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;