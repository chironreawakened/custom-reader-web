-- documents.cover_asset_id → assets.id
-- The typed .references() is kept one-way only (assets.document_id), because
-- the two-way cycle breaks TS 5.9 inference (TS7022). The reverse FK is
-- declared here instead — identical DDL to what Drizzle would have emitted.
ALTER TABLE "app"."documents" DROP CONSTRAINT "documents_cover_asset_id_assets_id_fk";
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_cover_asset_id_fkey" FOREIGN KEY ("cover_asset_id") REFERENCES "app"."assets"("id") ON DELETE set null ON UPDATE no action;
