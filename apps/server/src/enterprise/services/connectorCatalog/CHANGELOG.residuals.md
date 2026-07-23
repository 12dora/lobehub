# Connector catalog residuals (二开)

## 2026-07-24

- **Revision immutability (0145) cross-wave:** Publication tests seed adversarial revision rows with `SET LOCAL session_replication_role = 'replica'` (test-only). `publish` / `rollback` / `archive` map PG immutability (`55000` / `platform_resource_revisions are immutable`) and `PlatformRevisionImmutableError` to `PlatformRevisionConflictError` at the service boundary — revisions stay append-only.
- **Connection test unlocks Publish:** Successful `testConnection` is stored server-side (process-local, revision + draftToken bound). Draft refetch hydrates `connectionTest` so `successful_test_survives_refetch_and_unlocks_publish`. `connectorDraftToken` excludes `connectionTest` (AI-catalog parity).
- **Publish secret boundary:** Hard-fail `applyImmediate` / `tryPublishImmediate` never rethrows raw exceptions; only stable codes / `ConnectorPublishImmediateError` leave the service (`publish_error_does_not_echo_canary_secret_from_exception`).
- **OAuth refresh lease:** Failed refresh always releases the lease in `finally` (plus finite TTL reclaim on crash) so a held lease cannot livelock the binding revision.
