ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "dingtalk_title" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "dingtalk_user_id" text;
