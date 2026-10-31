CREATE TABLE "app"."assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"role" text NOT NULL,
	"mime" varchar(127) NOT NULL,
	"width" integer,
	"height" integer
);
--> statement-breakpoint
CREATE TABLE "app"."backups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"object_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"language" text,
	"status" text DEFAULT 'inbox' NOT NULL,
	"source_url" text,
	"original_object_id" uuid,
	"cover_asset_id" uuid,
	"parser_version" integer DEFAULT 1 NOT NULL,
	"ingest_state" text DEFAULT 'pending' NOT NULL,
	"ingest_error" text,
	"word_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"title" text,
	"html_object_id" uuid,
	"canonical_length" integer,
	"search_vector" "tsvector"
);
--> statement-breakpoint
CREATE TABLE "app"."toc_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"parent_id" uuid,
	"idx" integer NOT NULL,
	"label" text NOT NULL,
	"section_id" uuid,
	"anchor" text
);
--> statement-breakpoint
ALTER TABLE "app"."assets" ADD CONSTRAINT "assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."assets" ADD CONSTRAINT "assets_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."assets" ADD CONSTRAINT "assets_object_id_storage_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "app"."storage_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."backups" ADD CONSTRAINT "backups_object_id_storage_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "app"."storage_objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_original_object_id_storage_objects_id_fk" FOREIGN KEY ("original_object_id") REFERENCES "app"."storage_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_cover_asset_id_assets_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "app"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sections" ADD CONSTRAINT "sections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sections" ADD CONSTRAINT "sections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sections" ADD CONSTRAINT "sections_html_object_id_storage_objects_id_fk" FOREIGN KEY ("html_object_id") REFERENCES "app"."storage_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."toc_entries" ADD CONSTRAINT "toc_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."toc_entries" ADD CONSTRAINT "toc_entries_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."toc_entries" ADD CONSTRAINT "toc_entries_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "app"."sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_document_idx" ON "app"."assets" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "backups_kind_idx" ON "app"."backups" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "documents_user_idx" ON "app"."documents" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sections_document_idx_unique" ON "app"."sections" USING btree ("document_id","idx");--> statement-breakpoint
CREATE INDEX "sections_search_idx" ON "app"."sections" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "toc_document_idx" ON "app"."toc_entries" USING btree ("document_id");