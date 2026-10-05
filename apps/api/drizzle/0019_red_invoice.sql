ALTER TYPE "public"."invoice_status" ADD VALUE 'red_flushed';--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "red_flush_of" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "red_reason" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_red_flush_of_invoices_id_fk" FOREIGN KEY ("red_flush_of") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;