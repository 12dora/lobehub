# Partition: ai

## Summary

The AI catalog has a critical fail-open path when published providers are hard-deleted, plus correctness, scalability, and concurrency-test weaknesses. Credential redaction, request-format projection, stale connection-test invalidation, and zh-CN coverage within this partition were otherwise sound. CRITICAL: 1 · HIGH: 0 · MEDIUM: 3 · LOW: 2.

## Findings

### F1 \[CRITICAL]\[D5] Hard-deleting a published provider re-enables BYOK fallback

- **Location:** `apps/server/src/enterprise/services/aiCatalog/adminService.ts:422`, `apps/server/src/enterprise/services/aiCatalog/adminService.ts:432`, `apps/server/src/enterprise/services/aiCatalog/runtimeAdapter.ts:395`, `apps/server/src/enterprise/services/aiCatalog/runtimeAdapter.ts:398`, `src/enterprise/client/features/admin/ai/providers/ProviderListPage.tsx:131`, `src/enterprise/client/features/admin/ai/providers/openDeleteProviderModal.tsx:20`
- **Evidence:** `deleteProvider` checks only model dependencies, then executes `deleteProviderModels(id)`, `deleteProviderRevisions(id)`, and `deleteProvider(id)` without rejecting providers whose `revision > 0`. Runtime resolution subsequently performs `const known = await repository.getProviderByKey(providerKey);`; it throws the fail-closed `ProviderDisabled` error only when `known && known.revision > 0`, otherwise it executes `throw new AiCatalogNotFoundError()`. The admin UI exposes the hard-delete action based only on delete permission and describes it as an irreversible operation.
- **Impact / failure scenario:** An administrator publishes a managed provider, later disables or archives it, and then hard-deletes it. The runtime can no longer distinguish that deliberately removed managed provider from one never managed by the platform, emits the “not found” fallback signal, and user-supplied BYOK configuration becomes active. This bypasses the administrator’s provider prohibition.
- **Fix:** Reject hard deletion whenever the provider has ever been published (`revision > 0`); require archive/disable to preserve a fail-closed tombstone. Permit hard deletion only for never-published drafts, hide or disable the UI action otherwise, and add a publish → delete → runtime-resolution regression test.
- **Confidence:** HIGH

### F2 \[MEDIUM]\[D5] Superseded connection-test results are returned and audited as authoritative

- **Location:** `apps/server/src/enterprise/services/aiCatalog/adminService.ts:526`, `apps/server/src/enterprise/services/aiCatalog/adminService.ts:537`, `apps/server/src/enterprise/services/aiCatalog/adminService.ts:550`, `apps/server/src/enterprise/services/aiCatalog/adminService.draft.test.ts:212`
- **Evidence:** `completeProviderConnectionTest(...)` returns whether its attempt-ID CAS succeeded, but the service ignores that return value. It then appends an audit entry from its local `result` and returns that result. The existing test explicitly expects an older attempt to resolve as `failure` after a newer attempt has persisted `success`, then verifies that the stored state remains successful.
- **Impact / failure scenario:** Test A starts, test B supersedes it and succeeds, then A fails. A’s CAS updates no row, but its caller still receives failure and the audit log records failure while the authoritative provider state says success. Additionally, completion is committed before audit insertion; an audit failure can return an RPC error after the state change has already committed.
- **Fix:** Check the CAS result. For a superseded attempt, neither audit nor return the discarded probe result; return current persisted state or a stable superseded/conflict error. Perform successful CAS finalization and its audit insert in one transaction. FIX the existing test to assert the new consistent behavior.
- **Confidence:** HIGH

### F3 \[MEDIUM]\[D1] Model batch mutations repeatedly reload the entire draft

- **Location:** `apps/server/src/enterprise/services/aiCatalog/adminService.models.ts:422`, `apps/server/src/enterprise/services/aiCatalog/adminService.models.ts:438`, `apps/server/src/enterprise/services/aiCatalog/adminService.models.ts:463`, `apps/server/src/enterprise/services/aiCatalog/adminService.models.ts:513`, `apps/server/src/enterprise/services/aiCatalog/adminService.models.ts:538`, `apps/server/src/enterprise/services/aiCatalog/adminService.models.ts:550`
- **Evidence:** Each batch loop invokes a full per-model mutation helper and then calls `getProvider(providerId)` inside the loop. Batch update additionally rebuilds `modelMap` from the complete draft after every item. Batch clear repeats the same full reload after every deletion.
- **Impact / failure scenario:** A maximum-sized model batch generates hundreds of mutations plus hundreds of complete provider/model reads and repeated dependency work while holding the provider’s transactional lock. Runtime grows approximately quadratically with catalog size, increasing timeout risk and blocking publish or other administrative writes.
- **Fix:** Lock and validate the provider once, prefetch models and dependencies once, compute the final set in memory, use bulk insert/update/delete operations, update provider draft state once, and reload the resulting draft only once.
- **Confidence:** HIGH

### F4 \[MEDIUM]\[D2] PostgreSQL concurrency tests use wall-clock sleeps as lock assertions

- **Location:** `apps/server/src/enterprise/services/aiCatalog/publication.pgConcurrency.test.ts:162`, `apps/server/src/enterprise/services/aiCatalog/publication.pgConcurrency.test.ts:173`, `apps/server/src/enterprise/services/aiCatalog/publication.pgConcurrency.test.ts:295`, `apps/server/src/enterprise/services/aiCatalog/publication.pgConcurrency.test.ts:301`
- **Evidence:** The tests start a concurrent mutation, execute `await new Promise((resolve) => setTimeout(resolve, 50));`, and infer that locking worked because a boolean has not changed after 50 milliseconds.
- **Impact / failure scenario:** On a slow CI worker, the competing operation may not have reached the database before the assertion, so the test passes without proving it was blocked. Scheduling variance can also make the assertion flaky. A later revision-conflict result proves staleness rejection, not that the intended lock ordering occurred.
- **Fix:** FIX the tests by using a deterministic barrier that signals when the second transaction has reached its lock attempt, then assert it remains unsettled until the first transaction releases the lock. A narrowly scoped lifecycle hook or PostgreSQL lock-state observation can provide that synchronization.
- **Confidence:** HIGH

### F5 \[LOW]\[D3] Unused recursive model-reference helper remains in production code

- **Location:** `apps/server/src/enterprise/services/aiCatalog/dependencies.ts:13`
- **Evidence:** `jsonContainsModelReference` is defined as a recursive traversal and references only itself. No production or test caller uses it; dependency detection uses `jsonContainsAnyModelReference` instead.
- **Impact / failure scenario:** The duplicate traversal obscures which dependency algorithm is authoritative and increases the chance that a future fix is applied to dead code.
- **Fix:** DELETE `jsonContainsModelReference`.
- **Confidence:** HIGH

### F6 \[LOW]\[D1] Draft-publication retry discards a rejected promise

- **Location:** `src/enterprise/client/features/admin/ai/shared/AdminDraftPublishBanner.tsx:57`, `src/enterprise/client/features/admin/ai/shared/AdminDraftPublishBanner.tsx:88`, `src/enterprise/client/features/admin/ai/providerSettings/DraftPublishBanner.tsx:30`
- **Evidence:** `handleRetry` awaits `onRetry()` with a `finally` block but no `catch`; the click handler invokes it as `void handleRetry()`. The supplied retry callback awaits publication and refresh operations that can reject.
- **Impact / failure scenario:** If publication or either refresh fails, the promise rejects after being explicitly discarded. The spinner resets, but the banner provides no controlled failure state, and the browser receives an unhandled rejection.
- **Fix:** Catch the rejection in `handleRetry`, surface a localized inline error or toast, and ensure the click path always resolves after handling the failure.
- **Confidence:** HIGH

## Dimension coverage

① Code smells — Batch model operations contain repeated full-draft work (F3), and retry handling leaks a rejected promise (F6); credential projection and cleanup paths were otherwise bounded.

② Test rot — FIX the timing-dependent PostgreSQL tests (F4) and the stale-attempt test that locks in contradictory behavior (F2); ADD the published-provider hard-delete/BYOK regression for F1.

③ Dead code & dev cruft — The unused recursive dependency helper should be deleted (F5); no additional debug artifacts, commented-out implementations, or stale temporary files were confirmed.

④ Missing Simplified-Chinese i18n — Clean: checked AI-admin key references, English/zh-CN parity, and rendered strings; no missing or unintentionally English zh-CN value was confirmed.

⑤ Functional bugs — Issues cluster around hard-delete fail-open behavior (F1) and connection-test CAS/audit consistency (F2); transport and credential changes correctly invalidate tests, public projection preserves `enableResponseApi`, and secret material was not exposed by the partition’s runtime projection.
