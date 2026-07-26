# Retention / purge-outbox index predeploy (DB-006)

Migrations `0002_r4_w1_evidence` and `0011_r4_w2_db` add five partial indexes used by
legal-hold, retention, and purge-outbox scans. Fresh installs and empty tables can take the ordinary
`CREATE INDEX IF NOT EXISTS` path inside the migration transaction.

For **populated production** tables (`topics`, `platform_audit_exports`), prefer building
the indexes online before the migration lands:

```sql
-- Autocommit only — never wrap CREATE INDEX CONCURRENTLY in BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY IF NOT EXISTS topics_retention_updated_at_id_idx
  ON topics (updated_at, id)
  WHERE status IS NULL
     OR status IN ('active', 'completed', 'failed', 'archived', 'unread');

CREATE INDEX CONCURRENTLY IF NOT EXISTS platform_audit_exports_retention_sort_at_id_idx
  ON platform_audit_exports (
    (coalesce(finished_at, created_at)),
    id
  )
  WHERE storage_key IS NOT NULL
    AND status IN ('completed', 'expired');

CREATE INDEX CONCURRENTLY IF NOT EXISTS platform_audit_exports_purge_outbox_updated_at_id_v2_idx
  ON platform_audit_exports (updated_at, id)
  WHERE storage_key IS NULL
    AND status IN ('expired', 'failed', 'cancelled')
    AND (
      coalesce(error->>'purgeStorageKey', '') <> ''
      OR jsonb_typeof(error->'purgeStorageKeys') = 'array'
    );

CREATE INDEX CONCURRENTLY IF NOT EXISTS platform_audit_exports_purge_status_deleting_idx
  ON platform_audit_exports (id)
  WHERE coalesce(error->>'purgeStatus', '') = 'deleting';

CREATE INDEX CONCURRENTLY IF NOT EXISTS platform_audit_exports_purge_storage_key_expr_v2_idx
  ON platform_audit_exports ((coalesce(error->>'purgeStorageKey', '')))
  WHERE coalesce(error->>'purgeStorageKey', '') <> ''
     OR (
       jsonb_typeof(error->'purgeStorageKeys') = 'array'
       AND jsonb_array_length(error->'purgeStorageKeys') > 0
     );
```

Run the enforced predeploy command below; it creates all five indexes and rejects
missing, unready, or invalid entries in `pg_index`:

```bash
RETENTION_INDEX_PREDEPLOY_APPROVED=1 bun run enterprise:predeploy-retention-indexes
```

After it succeeds, both migrations are no-ops (`IF NOT EXISTS`). Obsolete
unversioned indexes may be retired later in a separately reviewed autocommit
deployment step; neither migration drops them.
