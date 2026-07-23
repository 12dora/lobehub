# OUT\_OF\_SCOPE\_NEEDED — connector catalog

## HIGH — durable multi-instance connection-test columns

**Location:** `packages/database` schema `platform_connectors` (out of bounds for this slice)

**Gap:** Connection-test success is process-local (`connectionTestState.ts`). Same-process refetch unlocks Publish; multi-instance / restart durability needs `connection_test_*` columns (AI-catalog parity) or another durable store. Schema/migrations are outside the allowed edit roots.

## MEDIUM — router soft-fail path already stable

Hard-fail rethrow is fixed in `catalogService.ts`. Soft-fail `publishError` was already a stable code string. Router mapping in `connectorsSupport.ts` is out of bounds and already treats `ConnectorPublishImmediateError` as a safe message.
