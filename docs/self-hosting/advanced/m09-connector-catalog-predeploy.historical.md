# M09 online index predeploy (historical)

> **APPLICABILITY: historical — not in active journal**
>
> Migration tag `0123` was absorbed into `0000_squash_baseline` during the enterprise
> squash. The active journal only contains tags listed in
> `packages/database/migrations/meta/_journal.json`. Do **not** look for a standalone
> `0123_*.sql` file. This document is retained for provenance and for operators who
> already ran the M09 predeploy script against a pre-squash database.

The script is deliberately autocommit-only because PostgreSQL rejects
`CREATE INDEX CONCURRENTLY` in a transaction.

```bash
M09_INDEX_PREDEPLOY_APPROVED=1 bun scripts/migrateServerDB/predeployM09ConnectorIndexes.ts
```

The command uses `DATABASE_URL`, sets `lock_timeout=5s` and `statement_timeout=30min`,
rejects duplicate keys, stops on an invalid/unfinished existing index, and verifies
`indisready`, `indisvalid`, and `indisunique` after each build.

On the squashed baseline, the unique indexes are created as ordinary
`CREATE UNIQUE INDEX IF NOT EXISTS` statements inside the baseline transaction. The
CONCURRENTLY predeploy path above is only relevant when applying the historical
pre-squash migration chain to a long-lived production database that has not been
recreated.
