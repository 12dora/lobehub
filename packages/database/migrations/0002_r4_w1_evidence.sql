-- Round-4 w1-evidence: partial expression indexes for purge-outbox hot paths.
-- Scope: ONLY purgeStatus / purgeStorageKey expression predicates (DB-001 legal-hold
-- create scan + retention outbox drains). w2-db owns the broader DB-006 index set
-- (retention sort keys, topics, etc.) — do not overlap those here.
-- Idempotent. CONCURRENTLY is not usable inside the migrator TX.

-- Legal-hold create + purge recovery: rows in two-phase purgeStatus=deleting.
CREATE INDEX IF NOT EXISTS "platform_audit_exports_purge_status_deleting_idx"
  ON "platform_audit_exports" ("id")
  WHERE coalesce("error"->>'purgeStatus', '') = 'deleting';
--> statement-breakpoint

-- Expression support for purge outbox presence scans. Predicate matches both
-- arms of listPendingArtifactPurges / completeArtifactObjectDelete (single key
-- OR non-empty purgeStorageKeys array) so the planner can use this partial index.
-- Use a versioned name so operators can prebuild the corrected predicate
-- concurrently. Retiring the obsolete name is a separate autocommit step.
CREATE INDEX IF NOT EXISTS "platform_audit_exports_purge_storage_key_expr_v2_idx"
  ON "platform_audit_exports" ((coalesce("error"->>'purgeStorageKey', '')))
  WHERE coalesce("error"->>'purgeStorageKey', '') <> ''
     OR (
       jsonb_typeof("error"->'purgeStorageKeys') = 'array'
       AND jsonb_array_length("error"->'purgeStorageKeys') > 0
     );
