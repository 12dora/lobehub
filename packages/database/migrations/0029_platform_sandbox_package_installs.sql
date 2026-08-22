-- Per-user sandbox package-install ledger. One row per (user, manager, package);
-- install_count is a lifetime accumulator bumped on each observed install command.
-- Idempotent (CREATE TABLE/INDEX IF NOT EXISTS + FK DO-block); safe to re-apply.
-- Hand-written because drizzle-kit generate is broken here (the schema glob eats
-- test files); `meta/0029_snapshot.json` is the 0028 ancestry plus this table.

CREATE TABLE IF NOT EXISTS "platform_sandbox_package_installs" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "manager" text NOT NULL,
  "package" text NOT NULL,
  "install_count" integer DEFAULT 1 NOT NULL,
  "last_command" text,
  "first_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "platform_sandbox_package_installs_manager_check" CHECK ("manager" IN ('apt', 'npm', 'pip'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "platform_sandbox_package_installs"
    DROP CONSTRAINT IF EXISTS "platform_sandbox_package_installs_user_id_users_id_fk";
  ALTER TABLE "platform_sandbox_package_installs"
    ADD CONSTRAINT "platform_sandbox_package_installs_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_sandbox_package_installs_user_manager_package_unique"
  ON "platform_sandbox_package_installs" USING btree ("user_id", "manager", "package");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_sandbox_package_installs_manager_package_last_at_idx"
  ON "platform_sandbox_package_installs" USING btree ("manager", "package", "last_at");
