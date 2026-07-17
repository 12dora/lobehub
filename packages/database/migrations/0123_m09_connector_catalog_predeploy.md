# M09 online index predeploy

Run this before deploying migration `0123` to a populated production database. The script is
deliberately autocommit-only because PostgreSQL rejects `CREATE INDEX CONCURRENTLY` in a
transaction.

```bash
M09_INDEX_PREDEPLOY_APPROVED=1 bun scripts/migrateServerDB/predeployM09ConnectorIndexes.ts
```

The command uses `DATABASE_URL`, sets `lock_timeout=5s` and `statement_timeout=30min`, rejects
duplicate keys, stops on an invalid/unfinished existing index, and verifies `indisready`,
`indisvalid`, and `indisunique` after each build. A timeout, duplicate, invalid index, lost
connection, or failed verification is a hard stop: do not run `0123` until the DBA resolves the
condition and the command succeeds.

Migration `0123` retains ordinary `CREATE UNIQUE INDEX IF NOT EXISTS` statements for fresh,
self-hosted, and test databases. If either existing table has more than 10,000 rows and the
prebuilt index is absent, the migration stops. A DBA may explicitly allow the blocking fallback
only in an approved maintenance window by setting the database/session custom setting
`aihub.m09_maintenance_window=on` on the migrator connection (for example through
`PGOPTIONS='-c aihub.m09_maintenance_window=on'`).
