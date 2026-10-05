CREATE TYPE "public"."invoice_status" AS ENUM('normal', 'voided');--> statement-breakpoint
CREATE TYPE "public"."invoice_type" AS ENUM('vat_special', 'vat_general', 'electronic', 'other');--> statement-breakpoint
CREATE TABLE "invoice_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"order_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_no" text NOT NULL,
	"invoice_type" "invoice_type" NOT NULL,
	"customer_id" integer NOT NULL,
	"tax_rate" numeric(6, 4) DEFAULT 0 NOT NULL,
	"amount_excl_cents" bigint NOT NULL,
	"tax_cents" bigint DEFAULT 0 NOT NULL,
	"amount_incl_cents" bigint NOT NULL,
	"issue_date" date NOT NULL,
	"status" "invoice_status" DEFAULT 'normal' NOT NULL,
	"void_reason" text,
	"voided_at" timestamp with time zone,
	"operator_id" integer,
	"void_operator_id" integer,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_orders" ADD CONSTRAINT "invoice_orders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_orders" ADD CONSTRAINT "invoice_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_void_operator_id_operators_id_fk" FOREIGN KEY ("void_operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_orders_inv_order_uq" ON "invoice_orders" USING btree ("invoice_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_no_normal_uq" ON "invoices" USING btree ("invoice_no") WHERE status = 'normal';