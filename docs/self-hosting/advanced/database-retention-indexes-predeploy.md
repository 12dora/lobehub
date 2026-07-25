# Retention / purge-outbox index predeploy (DB-006)

Migration `0011_r4_w2_db` adds three partial indexes used by audit retention scans and
purge-outbox recovery. Fresh installs and empty tables can take the ordinary
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

CREATE INDEX CONCURRENTLY IF NOT EXISTS platform_audit_exports_purge_outbox_updated_at_id_idx
  ON platform_audit_exports (updated_at, id)
  WHERE storage_key IS NULL
    AND status IN ('expired', 'failed', 'cancelled')
    AND (
      coalesce(error->>'purgeStorageKey', '') <> ''
      OR jsonb_typeof(error->'purgeStorageKeys') = 'array'
    );
```

After CONCURRENTLY succeeds, migration `0011_r4_w2_db` is a no-op (`IF NOT EXISTS`).
