CREATE TYPE "public"."product_type" AS ENUM('uk_acetylene', 'uk_propane', 'us_acetylene', 'us_propane');--> statement-breakpoint
CREATE TYPE "public"."settlement" AS ENUM('deposit_30_balance_before_ship', 'monthly_30', 'monthly_60', 'before_ship', 'prepay_30', 'monthly', 'cash');--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact" text,
	"settlement" "settlement",
	"credit_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"bound_pc" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "product_type" NOT NULL,
	"default_packaging" text,
	"default_routing" text,
	"safety_stock" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact" text,
	"settlement" "settlement",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
