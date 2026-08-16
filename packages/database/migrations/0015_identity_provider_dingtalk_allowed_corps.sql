-- Custom SQL migration: DingTalk organisation allowlist.
--
-- Which enterprises may sign in through a DingTalk login method is real policy state, so it gets
-- its own typed column rather than being overloaded onto `domain_allowlist` (email domains) or
-- `group_role_mapping` (IdP groups → platform roles). Entries are captured by running a DingTalk
-- login from the admin wizard — administrators never type a corpId by hand.
--
-- Fail-closed by construction: the column defaults to an empty array, an empty array allows
-- nobody at runtime, and publication rejects a DingTalk provider with an empty allowlist.
-- The CHECK also pins entries to the `dingtalk` kind, so switching a row's kind can never leave
-- a stale organisation grant behind.
--
-- Idempotent / convergent: ADD COLUMN IF NOT EXISTS + DROP/ADD CONSTRAINT may be re-applied.

ALTER TABLE "platform_identity_providers"
  ADD COLUMN IF NOT EXISTS "dingtalk_allowed_corps" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_identity_providers"
  DROP CONSTRAINT IF EXISTS "platform_identity_providers_dingtalk_corps_check";
--> statement-breakpoint
ALTER TABLE "platform_identity_providers"
  ADD CONSTRAINT "platform_identity_providers_dingtalk_corps_check"
  CHECK (
    jsonb_typeof("platform_identity_providers"."dingtalk_allowed_corps") = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."dingtalk_allowed_corps") = 'array' THEN "platform_identity_providers"."dingtalk_allowed_corps" ELSE '[]'::jsonb END) <= 200
    AND octet_length("platform_identity_providers"."dingtalk_allowed_corps"::text) <= 65536
    AND ("platform_identity_providers"."type" = 'dingtalk'
      OR jsonb_array_length(CASE WHEN jsonb_typeof("platform_identity_providers"."dingtalk_allowed_corps") = 'array' THEN "platform_identity_providers"."dingtalk_allowed_corps" ELSE '[]'::jsonb END) = 0)
    AND NOT jsonb_path_exists("platform_identity_providers"."dingtalk_allowed_corps", '$[*] ? (@.type() != "object")')
    AND NOT jsonb_path_exists("platform_identity_providers"."dingtalk_allowed_corps", '$[*] ? (!(exists(@.corpId)))')
    AND NOT jsonb_path_exists("platform_identity_providers"."dingtalk_allowed_corps", '$[*].corpId ? (@.type() != "string")')
    AND NOT jsonb_path_exists("platform_identity_providers"."dingtalk_allowed_corps", '$[*].corpId ? (!(@ like_regex "^[A-Za-z0-9_-]{1,64}$"))')
    AND NOT jsonb_path_exists("platform_identity_providers"."dingtalk_allowed_corps", '$[*].label ? (@.type() != "string")')
    AND NOT jsonb_path_exists("platform_identity_providers"."dingtalk_allowed_corps", '$[*].addedAt ? (@.type() != "string")')
  );
