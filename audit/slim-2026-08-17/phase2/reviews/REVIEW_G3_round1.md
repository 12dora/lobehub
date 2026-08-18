VERDICT: REWORK

## FINDINGS

1. **BLOCKER · `packages/database/src/models/user.ts:120,129` · [verified]** The bundled counts filter only by `userId`, while the replaced `MessageModel`/`SessionModel` calls also required `workspace_id IS NULL` in personal mode. Workspace activity can now set personal `hasConversation`, PWA-guide, and trace flags. This violates default byte-for-byte behavior. Add `isNull(messages.workspaceId)` and `isNull(sessions.workspaceId)` and test same-user workspace rows.

2. **BLOCKER · `packages/database/src/models/user.ts:104-114` · [verified]** The original upstream `getUserState` was restructured into a wrapper around `getUserStateBundle`; the batch helper is therefore reached by numerous existing onboarding, memory-extraction, and market callers, not one place. Every such call now executes two unnecessary count subqueries. Restore the original `getUserState` path and keep the bundle isolated to the router’s single batch call.

3. **BLOCKER · `apps/server/src/enterprise/services/memory/personaReadMemo.ts:1,58-61` · [verified]** `UserPersonaModel` and its schema graph are statically imported, and the write listener is bound before the memory-module gate. A disabled memory module therefore still loads the heavy path, violating the gate-before-import rule. Use a type-only import and place a single-flight `await import()` behind `isModuleEnabled('memory')`.

4. **BLOCKER · `packages/database/src/models/userMemory/persona.ts:28-34,92,208` · [verified]** The new global listener registry and write-path changes are upstream restructuring beyond the permitted seams. Additionally, line 208 invalidates inside the transaction callback, before commit: another request can repopulate the old persona between invalidation and commit and retain it for 30 seconds. Remove the upstream listener machinery and rely on the compliant TTL, or use an authorized fork-owned post-commit invalidation seam.

5. **BLOCKER · `packages/context-engine/src/engine/topicReference/resolveTopicReferences.ts:83-151` · [verified]** The batch work also refactors the existing resolver’s fallback path and broadens its public signature. That exceeds the permitted one-place batch-helper change. Restore the legacy resolver byte-for-byte and expose the new batch implementation as a separate helper called only by the server adapter.

6. **MAJOR · `packages/database/src/models/message.ts:478-490` · [verified]** The batch query loads every ungrouped message for every referenced topic, then retains five in JavaScript. Large topics can produce unbounded rows and memory, replacing the old per-topic 1,000-row ceiling. Apply the role/content filters and a per-topic five-row limit in SQL, preserving chronological output, and add a large-topic regression test.

7. **MAJOR · `apps/server/src/modules/AgentRuntime/adapters/serverCallLlmContextBuilder.topicRefs.test.ts:81,106` · [verified]** Both casts fail TS2352 because the mocked argument type contains only `messages` and does not overlap the asserted `topicReferences` shape. `tsgo --noEmit` reported both errors. Correct the mock typing or cast through `unknown`.

## METRICS

- Files reviewed: **21**
- Enterprise/fork-owned files: **6**
- Upstream files touched: **15**

Rule 2 compliance:

- **No:** `packages/database/src/models/user.ts` — existing method restructured; batch helper no longer single-call-site.
- **No:** `packages/database/src/models/userMemory/persona.ts` — global listener registry and write-path restructuring.
- **No:** `packages/context-engine/src/engine/topicReference/resolveTopicReferences.ts` — legacy implementation refactored instead of isolated.
- **Yes:** `apps/server/src/routers/lambda/user.ts` — mechanical wrapper call.
- **Yes:** `apps/server/src/routers/lambda/__tests__/user.test.ts` — corresponding test dependency updates.
- **Yes:** `apps/server/src/modules/AgentRuntime/adapters/serverCallLlmContextBuilder.ts` — batch-call and `await import()` swaps.
- **Yes:** `apps/server/src/modules/AgentRuntime/adapters/serverCallLlmContextBuilder.topicRefs.test.ts` — brief-required coverage, though type-broken.
- **Yes:** `apps/server/src/services/aiAgent/index.ts` scoped region — one import and persona-read replacement.
- **Yes:** `packages/context-engine/src/engine/topicReference/index.ts` — one-line export.
- **Yes:** `packages/context-engine/src/engine/topicReference/__tests__/resolveTopicReferences.test.ts` — batch coverage only.
- **Yes:** `packages/database/src/models/message.ts` — one-place batch helper.
- **Yes:** `packages/database/src/models/topic.ts` — one-place batch helper.
- **Yes:** the three new database model tests — brief-required helper coverage.

## UNVERIFIED

- Vitest was not run, per the read-only sandbox constraint; all reported test-pass counts remain unverified.
- The no-emit type check could not write `tsconfig.tsbuildinfo` and also reported unrelated out-of-scope errors. The two scoped TS2352 diagnostics above are verified; an otherwise clean full type-check is unverified.
- SQL execution plans, PGlite behavior, pipeline timing, and the reported query/load reductions were not reproduced.