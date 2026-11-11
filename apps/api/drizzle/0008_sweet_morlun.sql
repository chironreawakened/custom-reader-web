CREATE TABLE "app"."tts_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."tts_cache" ADD CONSTRAINT "tts_cache_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tts_cache" ADD CONSTRAINT "tts_cache_object_id_storage_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "app"."storage_objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tts_cache_user_idx" ON "app"."tts_cache" USING btree ("user_id");