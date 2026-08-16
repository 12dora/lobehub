-- Custom SQL migration: admit the `dingtalk` login-method kind.
--
-- `platform_identity_providers.type` is a varchar guarded by a CHECK rather than a pgEnum, so a
-- new admin-configurable kind is a DROP/ADD of that single constraint. DingTalk (钉钉) is plain
-- OAuth 2.0 — no discovery document, no id_token, and a header-authenticated profile endpoint —
-- but every other column contract still holds: `use_pkce` stays TRUE (the runtime adapter turns
-- PKCE off for this kind), `scopes` still contains `openid`, and `claim_mapping` still carries
-- exactly the six canonical keys.
--
-- Idempotent / convergent: DROP ... IF EXISTS followed by ADD may be re-applied safely, and the
-- widened predicate accepts every row the previous predicate accepted.

ALTER TABLE "platform_identity_providers"
  DROP CONSTRAINT IF EXISTS "platform_identity_providers_type_check";
--> statement-breakpoint
ALTER TABLE "platform_identity_providers"
  ADD CONSTRAINT "platform_identity_providers_type_check"
  CHECK ("platform_identity_providers"."type" IN ('authentik', 'generic_oidc', 'dingtalk'));
