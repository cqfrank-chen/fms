CREATE TYPE "public"."iqc_status" AS ENUM('pending', 'passed');--> statement-breakpoint
CREATE TYPE "public"."oqc_status" AS ENUM('pending', 'passed', 'exempt');--> statement-breakpoint
CREATE TYPE "public"."outbound_status" AS ENUM('draft', 'pending', 'shipped', 'voided');--> statement-breakpoint
ALTER TYPE "public"."receipt_status" ADD VALUE 'voided';--> statement-breakpoint
CREATE TABLE "incoming_goods" (
	"id" serial PRIMARY KEY NOT NULL,
	"incoming_no" text NOT NULL,
	"supplier_id" integer NOT NULL,
	"material_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"batch_no" text,
	"iqc_status" "iqc_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incoming_goods_incoming_no_unique" UNIQUE("incoming_no")
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"batch_no" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"outbound_id" integer NOT NULL,
	"order_line_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"packaging" jsonb
);
--> statement-breakpoint
CREATE TABLE "outbounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"ship_no" text NOT NULL,
	"order_id" integer NOT NULL,
	"oqc" "oqc_status" NOT NULL,
	"status" "outbound_status" DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"shipped_at" timestamp with time zone,
	CONSTRAINT "outbounds_ship_no_unique" UNIQUE("ship_no")
);
--> statement-breakpoint
CREATE TABLE "payables" (
	"id" serial PRIMARY KEY NOT NULL,
	"pay_no" text NOT NULL,
	"supplier_id" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_id" integer NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"settled_amount" numeric(10, 2) DEFAULT 0 NOT NULL,
	"status" "receipt_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payables_pay_no_unique" UNIQUE("pay_no")
);
--> statement-breakpoint
CREATE TABLE "receivables" (
	"id" serial PRIMARY KEY NOT NULL,
	"recv_no" text NOT NULL,
	"customer_id" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_id" integer NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'RMB' NOT NULL,
	"settled_amount" numeric(10, 2) DEFAULT 0 NOT NULL,
	"status" "receipt_status" DEFAULT 'draft' NOT NULL,
	"due_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receivables_recv_no_unique" UNIQUE("recv_no")
);
--> statement-breakpoint
CREATE TABLE "stocktakes" (
	"id" serial PRIMARY KEY NOT NULL,
	"stocktake_no" text NOT NULL,
	"product_id" integer NOT NULL,
	"batch_no" text NOT NULL,
	"book_qty" integer NOT NULL,
	"actual_qty" integer NOT NULL,
	"diff_qty" integer NOT NULL,
	"status" "receipt_status" DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "stocktakes_stocktake_no_unique" UNIQUE("stocktake_no")
);
--> statement-breakpoint
ALTER TABLE "incoming_goods" ADD CONSTRAINT "incoming_goods_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_lines" ADD CONSTRAINT "outbound_lines_outbound_id_outbounds_id_fk" FOREIGN KEY ("outbound_id") REFERENCES "public"."outbounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_lines" ADD CONSTRAINT "outbound_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_lines" ADD CONSTRAINT "outbound_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbounds" ADD CONSTRAINT "outbounds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payables" ADD CONSTRAINT "payables_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_product_batch_uq" ON "inventory" USING btree ("product_id","batch_no");