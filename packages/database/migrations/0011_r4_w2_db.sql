-- Round-4 w2-db: retention / purge-outbox indexes (DB-006)
-- Idempotent follow-up to the squashed baseline. Safe for fresh install and upgrade.
-- Online CONCURRENTLY predeploy for large production tables: see
-- docs/self-hosting/advanced/database-retention-indexes-predeploy.md

-- Topics retention scan: (updated_at, id) over purgeable + legacy-null statuses.
CREATE INDEX IF NOT EXISTS "topics_retention_updated_at_id_idx"
  ON "topics" ("updated_at", "id")
  WHERE "status" IS NULL
     OR "status" IN ('active', 'completed', 'failed', 'archived', 'unread');
--> statement-breakpoint

-- Export retention candidates: coalesce(finished_at, created_at), id
-- only for completed/expired rows that still hold a private object.
CREATE INDEX IF NOT EXISTS "platform_audit_exports_retention_sort_at_id_idx"
  ON "platform_audit_exports" (
    (coalesce("finished_at", "created_at")),
    "id"
  )
  WHERE "storage_key" IS NOT NULL
    AND "status" IN ('completed', 'expired');
--> statement-breakpoint

-- Purge-outbox recovery: terminal rows with storage_key cleared and purge key(s) present.
-- Predicate must imply listPendingArtifactPurges (A OR B for single key / keys array).
-- DROP first: an earlier revision of this migration shipped a narrower single-conjunct
-- predicate, and CREATE INDEX IF NOT EXISTS would silently leave it in place.
DROP INDEX IF EXISTS "platform_audit_exports_purge_outbox_updated_at_id_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_audit_exports_purge_outbox_updated_at_id_idx"
  ON "platform_audit_exports" ("updated_at", "id")
  WHERE "storage_key" IS NULL
    AND "status" IN ('expired', 'failed', 'cancelled')
    AND (
      coalesce("error"->>'purgeStorageKey', '') <> ''
      OR jsonb_typeof("error"->'purgeStorageKeys') = 'array'
    );
