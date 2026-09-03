CREATE TYPE "public"."cost_category" AS ENUM('labor', 'electricity', 'gas', 'rent', 'depreciation', 'other');--> statement-breakpoint
CREATE TYPE "public"."slip_mode" AS ENUM('settle', 'prepay');--> statement-breakpoint
CREATE TYPE "public"."slip_status" AS ENUM('confirmed', 'voided');--> statement-breakpoint
CREATE TABLE "collection_slip_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"slip_id" integer NOT NULL,
	"receivable_id" integer NOT NULL,
	"amount" numeric(10, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_slips" (
	"id" serial PRIMARY KEY NOT NULL,
	"collect_no" text NOT NULL,
	"customer_id" integer NOT NULL,
	"mode" "slip_mode" NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"status" "slip_status" DEFAULT 'confirmed' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	CONSTRAINT "collection_slips_collect_no_unique" UNIQUE("collect_no")
);
--> statement-breakpoint
CREATE TABLE "monthly_costs" (
	"id" serial PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"category" "cost_category" NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_slip_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"slip_id" integer NOT NULL,
	"payable_id" integer NOT NULL,
	"amount" numeric(10, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_slips" (
	"id" serial PRIMARY KEY NOT NULL,
	"pay_no" text NOT NULL,
	"supplier_id" integer NOT NULL,
	"mode" "slip_mode" NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"status" "slip_status" DEFAULT 'confirmed' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	CONSTRAINT "payment_slips_pay_no_unique" UNIQUE("pay_no")
);
--> statement-breakpoint
ALTER TABLE "collection_slip_lines" ADD CONSTRAINT "collection_slip_lines_slip_id_collection_slips_id_fk" FOREIGN KEY ("slip_id") REFERENCES "public"."collection_slips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_slip_lines" ADD CONSTRAINT "collection_slip_lines_receivable_id_receivables_id_fk" FOREIGN KEY ("receivable_id") REFERENCES "public"."receivables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_slips" ADD CONSTRAINT "collection_slips_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_slip_lines" ADD CONSTRAINT "payment_slip_lines_slip_id_payment_slips_id_fk" FOREIGN KEY ("slip_id") REFERENCES "public"."payment_slips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_slip_lines" ADD CONSTRAINT "payment_slip_lines_payable_id_payables_id_fk" FOREIGN KEY ("payable_id") REFERENCES "public"."payables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_slips" ADD CONSTRAINT "payment_slips_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monthly_cost_month_cat_uq" ON "monthly_costs" USING btree ("month","category");