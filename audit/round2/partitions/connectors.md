# Partition: connectors

## Summary

The partition has strong CAS, secret-redaction, and shared-OAuth identity controls, but governance degradation can fail open, and runtime audit reconciliation is incomplete on serverless deployments. Several bounded lifecycle and UI consistency defects remain. `CRITICAL: 1 · HIGH: 1 · MEDIUM: 3 · LOW: 2`.

## Findings

### F1 \[CRITICAL]\[D5] Same-epoch governance fallback can restore permissions after a restrictive policy commit

- **Location:** `apps/server/src/enterprise/services/connectorGovernance/resolve.ts:20`, `apps/server/src/enterprise/services/connectorGovernance/service.ts:30`, `apps/server/src/enterprise/services/connectorGovernance/service.ts:108`, `apps/server/src/enterprise/services/connectorGovernance/service.ts:138`, `apps/server/src/enterprise/services/connectorGovernance/adminService.ts:164`, `apps/server/src/enterprise/services/connectorGovernance/service.test.ts:221`
- **Evidence:** On any authoritative read failure, the resolver executes `getLastKnownConnectorGovernanceIfCurrent()` and returns that snapshot. The LKG stores only `{ epoch, resolved }`, has no expiry or database revision, and is accepted whenever the external epoch still matches. Governance invalidation is explicitly best-effort: `try { await this.invalidation.publish(...) } catch ...`. The test codifies the unsafe behavior: `mockRejectedValue(...)`, `mockResolvedValue(lkg)`, then `expect(resolveConnectorGovernance(db)).resolves.toEqual(lkg)`.
- **Impact / failure scenario:** A permissive snapshot is cached; an administrator commits enforced tool denials or a mandatory shared-OAuth owner; invalidation fails, leaving the epoch unchanged; then the database governance read fails. Runtime returns the old permissive LKG, restoring disabled builtin tools or the invoking user’s OAuth identity. Because LKG has no TTL, repeated failures can continue bypassing the committed policy.
- **Fix:** On authoritative resolution failure, return `DENIED_CONNECTOR_GOVERNANCE` unconditionally. Do not treat an external epoch as proof that the database policy is unchanged unless the policy revision and invalidation version are committed atomically. **FIX** the same-epoch test to expect deny-all and add the restrictive-commit/invalidation-failure/read-failure regression.
- **Confidence:** HIGH

### F2 \[HIGH]\[D5] Serverless deployments can strand connector runtime audits indefinitely

- **Location:** `apps/server/src/enterprise/services/connectorCatalog/runtimeAuditWorker.ts:27`, `apps/server/src/enterprise/services/connectorCatalog/runtimeExecutionJournal.ts:188`, `apps/server/src/enterprise/services/connectorCatalog/runtimeExecutionJournal.ts:263`, `apps/server/src/enterprise/services/connectorCatalog/runtimeExecutionJournal.ts:281`, `apps/server/src/enterprise/services/connectorCatalog/runtimeAdapter.ts:366`, `apps/server/src/enterprise/services/connectorCatalog/runtimeAuditWorker.test.ts:21`
- **Evidence:** Completed shared-credential calls are stored with `auditStatus: 'pending'` and `status: 'pending'`. Audit-delivery failure is caught and logged while the successful tool result is returned. Reconciliation exists only through `runConnectorRuntimeAuditBatch`, but startup returns immediately when `process.env.VERCEL_ENV` is set. The test manually invokes the batch and covers only successful persistent-worker convergence; no serverless scheduler or queue entrypoint exists in the source.
- **Impact / failure scenario:** On Vercel, a shared-credential call succeeds but its terminal audit append fails transiently. The user receives the result, while the journal remains pending unless the exact same call is replayed. If an outbound call becomes ambiguous after `arm`, its eventual `unknown` audit likewise depends on the disabled worker. Normal traffic does not guarantee either record is reconciled, leaving incomplete compliance evidence indefinitely.
- **Fix:** Provide a durable serverless scheduler/queue path that invokes bounded `runConnectorRuntimeAuditBatch` work, and make runtime readiness fail closed when neither the persistent poller nor that serverless reconciler is configured. **ADD** tests for Vercel pending and expired-running convergence.
- **Confidence:** HIGH

### F3 \[MEDIUM]\[D5] Cache refresh failures are reported as mutation failures after the server has committed

- **Location:** `src/enterprise/client/features/admin/connectors/useConnectorActions.tsx:107`, `src/enterprise/client/features/admin/connectors/useConnectorActions.tsx:143`, `src/enterprise/client/features/admin/connectors/useConnectorActions.tsx:373`, `src/enterprise/client/features/admin/connectors/useConnectorActions.test.tsx:119`
- **Evidence:** `run()` places both `await operation()` and `await Promise.all([mutate(), refreshAdminConnectorLists()])` inside one `try`; either refresh rejection enters the mutation failure handler. Save then executes `setSaveState('failed')` without `markSaved()`. Delete similarly awaits list refresh before success toast and navigation, and treats a refresh rejection as deletion failure.
- **Impact / failure scenario:** A save commits revision N+1, but SWR revalidation fails. The editor reports failure and retains stale revision N; retrying produces a revision conflict despite the first save succeeding. For delete, the record is gone but the modal reports failure and does not navigate; retry returns not-found. Publish, rollback, archive, and binding revocation have the same false-negative behavior.
- **Fix:** Separate mutation completion from cache synchronization. Once `operation()` resolves, mark the action committed and update save/navigation state; run revalidation with `Promise.allSettled` or a separate refresh-error path that never reclassifies the mutation. **ADD** save and delete regressions with rejected refresh promises.
- **Confidence:** HIGH

### F4 \[MEDIUM]\[D5] The server allows publish without the connection test required by the admin UI

- **Location:** `src/enterprise/client/features/admin/connectors/controller.ts:145`, `src/enterprise/client/features/admin/connectors/useConnectorActions.tsx:263`, `apps/server/src/enterprise/services/connectorCatalog/publicationService.ts:309`, `apps/server/src/enterprise/services/connectorCatalog/connectorOutboundClient.ts:56`, `apps/server/src/enterprise/services/connectorCatalog/publicationService.test.ts:100`
- **Evidence:** The UI exposes publish only when `testPassed && canPublish`, and `publish` additionally checks `isPersistedConnectorTestCurrent(...)`. Server `preflightPublish`, however, validates tools and calls only `outbound.preflight(endpoint)`, which delegates to the SSRF-policy preflight and performs no connector request or connection-test-state check. The publication test creates a draft and successfully calls `publication.publish(...)` without ever testing it.
- **Impact / failure scenario:** An API client—or a stale/custom frontend—can publish an untested connector, or mutate a previously tested draft and publish the new endpoint/credentials directly. DNS/SSRF eligibility passes even when the service is unreachable, credentials are rejected, or its protocol is invalid, so a broken connector becomes the runtime head.
- **Fix:** Enforce the invariant inside `preflightPublish`. The minimal robust change is to perform the same live connection probe during publish and reject anything except success; alternatively persist test status bound to the exact revision and draft token and verify it server-side. **FIX** the existing publication fixture and **ADD** no-test, failed-test, and stale-test rejection cases.
- **Confidence:** HIGH

### F5 \[MEDIUM]\[D5] Feature-disabled disconnect reports success without revoking the OAuth binding

- **Location:** `apps/server/src/enterprise/routers/user/connectors.ts:66`, `apps/server/src/enterprise/services/connectorCatalog/userOAuthService.ts:601`, `apps/server/src/enterprise/routers/user/connectors.test.ts:92`
- **Evidence:** The router returns `{ disconnected: true }` immediately when `ENABLE_PLATFORM_MANAGED_CONNECTORS` is off, without calling `UserConnectorOAuthService.disconnect`. The real service would transactionally revoke the binding and clean its token references. The router test explicitly expects the false-success response while the feature is disabled.
- **Impact / failure scenario:** A user disconnects while the feature is disabled and receives confirmation, but the connected binding and token remain stored. Re-enabling the feature resurrects the supposedly disconnected authorization and retains credentials the user believed were removed.
- **Fix:** Route disconnect through a flag-independent revocation path and perform best-effort secret cleanup. If revocation dependencies are unavailable, return an explicit failure instead of success. **FIX** the flag-off test to assert an actual revoked binding and detached token reference.
- **Confidence:** HIGH

### F6 \[LOW]\[D1] Deleted connectors remain in an unbounded process-local connection-test map

- **Location:** `apps/server/src/enterprise/services/connectorCatalog/connectionTestState.ts:19`, `apps/server/src/enterprise/services/connectorCatalog/connectionTestState.ts:21`, `apps/server/src/enterprise/services/connectorCatalog/connectionTestState.ts:51`, `apps/server/src/enterprise/services/connectorCatalog/draftService.ts:670`
- **Evidence:** Every test writes `byConnectorId.set(connectorId, ...)`. A cleanup function exists, but has no production callers. `deleteDraft` removes database rows and returns without clearing the map; the map has no TTL or size bound.
- **Impact / failure scenario:** Repeated create → test → delete cycles retain one result per deleted connector for the lifetime of every server process. Long-lived admin servers accumulate unreachable objects indefinitely.
- **Fix:** Call `clearConnectorConnectionTest(command.id)` only after the delete transaction commits, and add a deletion regression. A TTL or bounded cache would additionally protect against missed lifecycle paths.
- **Confidence:** HIGH

### F7 \[LOW]\[D3] Deprecated governance alias has no callers

- **Location:** `apps/server/src/enterprise/services/connectorGovernance/types.ts:89`
- **Evidence:** `UNAVAILABLE_CONNECTOR_GOVERNANCE` merely aliases `DENIED_CONNECTOR_GOVERNANCE` “for import stability.” A repository-wide symbol search finds no import or use beyond this declaration.
- **Impact / failure scenario:** The duplicate name preserves obsolete terminology and increases the chance that future code treats “unavailable” as a distinct policy state even though both constants are the same object.
- **Fix:** Remove the unused alias and its deprecation comment.
- **Confidence:** HIGH

## Dimension coverage

① Code smells — Reviewed large services, pagination loops, caches, cleanup, and resource lifecycles; the unbounded connection-test map is F6, with no confirmed N+1 or query-bound defect elsewhere.

② Test rot — No `skip`, `todo`, or `only` tests found; **FIX** the unsafe same-epoch governance and flag-off disconnect expectations, **FIX/ADD** publish-test enforcement, and **ADD** serverless reconciliation and refresh-failure regressions described in F1–F5.

③ Dead code & dev cruft — The zero-caller deprecated governance alias is F7; no committed debug statements, commented-out implementation, or duplicate artifact was confirmed.

④ Missing Simplified-Chinese i18n — Clean: all 142 `connectorCatalog.*` en-US keys have zh-CN counterparts, none retain the English value, referenced literal keys resolve, and no user-facing connector UI string was found hardcoded outside i18n.

⑤ Functional bugs — Issues cluster in governance degradation, terminal audit convergence, post-commit UI state, publish/test enforcement, and feature-toggle disconnect semantics (F1–F5). Shared-OAuth owner substitution, binding ownership checks, masked-secret keep/clear/replace handling, deep runtime redaction, CAS publication, and connector schema constraints were checked and no additional defect was confirmed.
