ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "remark" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "legacy_name" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_packagings" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"packaging" text NOT NULL,
	"note" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_packagings" ADD CONSTRAINT "product_packagings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_packagings_product_packaging_uq" ON "product_packagings" USING btree ("product_id","packaging");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_packagings_product_idx" ON "product_packagings" USING btree ("product_id");