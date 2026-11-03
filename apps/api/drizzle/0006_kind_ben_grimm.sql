CREATE TABLE "app"."document_tags" (
	"document_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "document_tags_document_id_tag_id_pk" PRIMARY KEY("document_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "app"."tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."document_tags" ADD CONSTRAINT "document_tags_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_tags" ADD CONSTRAINT "document_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "app"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tags_user_name_unique" ON "app"."tags" USING btree ("user_id",lower("name"));