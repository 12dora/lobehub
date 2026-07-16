DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_skill_versions'
      AND column_name = 'zip_hash'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_skill_versions'
      AND column_name = 'checksum'
  ) THEN
    ALTER TABLE "platform_skill_versions" RENAME COLUMN "zip_hash" TO "checksum";
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_skills'
      AND column_name = 'current_version'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_skills'
      AND column_name = 'current_version_id'
  ) THEN
    ALTER TABLE "platform_skills" RENAME COLUMN "current_version" TO "current_version_id";
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ALTER COLUMN "manifest" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ADD COLUMN IF NOT EXISTS "content" text;--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ADD COLUMN IF NOT EXISTS "checksum" text;--> statement-breakpoint
UPDATE "platform_skill_versions" SET "content" = '' WHERE "content" IS NULL;--> statement-breakpoint
UPDATE "platform_skill_versions" SET "checksum" = repeat('0', 64) WHERE "checksum" IS NULL;--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ALTER COLUMN "content" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_skill_versions" ALTER COLUMN "checksum" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_skills" DROP CONSTRAINT IF EXISTS "platform_skills_current_version_id_platform_skill_versions_id_fk";--> statement-breakpoint
ALTER TABLE "platform_skills" ADD CONSTRAINT "platform_skills_current_version_id_platform_skill_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."platform_skill_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_skill_versions_checksum_idx" ON "platform_skill_versions" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_skills_distribution_idx" ON "platform_skills" USING btree ("distribution");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_skills_current_version_id_idx" ON "platform_skills" USING btree ("current_version_id");--> statement-breakpoint
ALTER TABLE "platform_skills" DROP COLUMN IF EXISTS "manifest";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_platform_skill_version_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform_skill_versions are immutable'
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "platform_skill_versions_immutable" ON "platform_skill_versions";--> statement-breakpoint
CREATE TRIGGER "platform_skill_versions_immutable"
BEFORE UPDATE OR DELETE ON "platform_skill_versions"
FOR EACH ROW EXECUTE FUNCTION "prevent_platform_skill_version_mutation"();
