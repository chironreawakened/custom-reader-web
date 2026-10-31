CREATE TABLE "app"."reading_progress" (
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"locator" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_progress_user_id_document_id_pk" PRIMARY KEY("user_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "app"."user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"openai_key_enc" text,
	"openai_key_last4" text,
	"key_version" integer,
	"tts_model" text,
	"tts_voice" text,
	"reader_prefs" jsonb
);
--> statement-breakpoint
ALTER TABLE "app"."reading_progress" ADD CONSTRAINT "reading_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reading_progress" ADD CONSTRAINT "reading_progress_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;