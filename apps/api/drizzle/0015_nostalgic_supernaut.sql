CREATE TABLE "outbound_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"outbound_line_id" integer NOT NULL,
	"inventory_id" integer,
	"batch_no" text NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incoming_goods" ADD COLUMN "status" "receipt_status" DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_allocations" ADD CONSTRAINT "outbound_allocations_outbound_line_id_outbound_lines_id_fk" FOREIGN KEY ("outbound_line_id") REFERENCES "public"."outbound_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_allocations" ADD CONSTRAINT "outbound_allocations_inventory_id_inventory_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE no action ON UPDATE no action;