-- Custom SQL migration: admit the `off` audit content-redaction profile.
--
-- `platform_audit_policies.redaction_profile` is a varchar guarded by a CHECK rather than a
-- pgEnum, so a new stored value is a DROP/ADD of that single constraint. Default stays
-- `'strict'`; existing `strict` / `standard` rows are accepted by the widened predicate.
-- `'off'` skips live-view conversation credential masking; durable exports still mask.
--
-- Idempotent / convergent: DROP ... IF EXISTS followed by ADD may be re-applied safely, and the
-- widened predicate accepts every row the previous predicate accepted.

ALTER TABLE "platform_audit_policies"
  DROP CONSTRAINT IF EXISTS "platform_audit_policies_redaction_profile_check";
--> statement-breakpoint
ALTER TABLE "platform_audit_policies"
  ADD CONSTRAINT "platform_audit_policies_redaction_profile_check"
  CHECK ("platform_audit_policies"."redaction_profile" IN ('strict', 'standard', 'off'));
