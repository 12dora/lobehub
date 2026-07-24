# Connector catalog residuals (二开)

## 2026-07-24

- **Revision immutability (0145) cross-wave:** Publication tests seed adversarial revision rows with `SET LOCAL session_replication_role = 'replica'` (test-only). `publish` / `rollback` / `archive` map PG immutability (`55000` / `platform_resource_revisions are immutable`) and `PlatformRevisionImmutableError` to `PlatformRevisionConflictError` at the service boundary — revisions stay append-only.
- **Connection test unlocks Publish:** Successful `testConnection` is stored durable on `platform_connectors.connection_test_*` (revision + draftToken + testedAt TTL bound). Publish and draft loads project those columns from the already-fetched connector row (no request-time DDL, no process-local authorization fallback, no per-id N+1). Absent/unreadable durable state fails closed. Formal migration is owned by the DB batch.
- **Publish secret boundary:** Hard-fail `applyImmediate` / `tryPublishImmediate` never rethrows raw exceptions; only stable codes / `ConnectorPublishImmediateError` leave the service (`publish_error_does_not_echo_canary_secret_from_exception`).
- **OAuth refresh lease:** Failed refresh always releases the lease in `finally` (plus finite TTL reclaim on crash) so a held lease cannot livelock the binding revision.
