ALTER TABLE "app"."documents" ADD COLUMN "pdf_mode_available" text;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD COLUMN "pdf_has_text" boolean;--> statement-breakpoint
ALTER TABLE "app"."toc_entries" ADD COLUMN "page" integer;
