# VERDICT: REWORK

The Round 1 findings B1–B5 and M6–M7 are closed in code, but three new BLOCKER regressions remain.

## FINDINGS

1. **BLOCKER · `packages/database/src/models/message.ts:491-499` · [verified]** The batch query omits the legacy fallback’s `thread_id IS NULL` constraint. `MessageModel.query()` previously added `matchThread(undefined)`, so child-thread messages were excluded; the new query can inject them into the referenced root-topic context and let newer thread turns crowd out root messages. This violates default-path equivalence. Add `isNull(messages.threadId)` and a regression test with newer child-thread messages.

2. **BLOCKER · `packages/database/src/models/message.ts:484-512` · [verified]** `trim(content) <> ''` does not match JavaScript `content.trim()`: PostgreSQL’s default `trim` removes ordinary spaces, while the legacy filter also rejects tabs, newlines, and other whitespace. Because ranking/capping happens before `toRecentMessages` applies the JS filter, five newer whitespace-only rows can consume the quota and hide an older valid message. Use a SQL predicate equivalent to the legacy whitespace test before `ROW_NUMBER()`, and test whitespace rows occupying the newest positions.

3. **BLOCKER · `apps/server/src/enterprise/services/memory/personaReadMemo.ts:28-35`; `apps/server/src/enterprise/services/user/userInfoReadMemo.ts:34-42` · [verified]** Both bounded caches may evict their oldest entry while it is still in flight. At 256 concurrent distinct keys, another request can evict an unresolved slot; a repeated request for that key then starts a second model/DB load, violating the required single-flight guarantee. Never evict in-flight slots—or keep in-flight promises in a separate uncapped map and permit temporary overflow—and add a saturation/concurrency test.

## METRICS

- Files reviewed: **21**
- Files touched in scope: **20** — 14 upstream, 6 enterprise/fork-owned.
- Round 1 closure verified: workspace-null counts restored; legacy `getUserState` and resolver restored; persona import gated; write listener removed; SQL row cap added; TS2352 casts corrected.

Upstream Rule 2 compliance:

- `apps/server/src/routers/lambda/user.ts` — **Yes**, wrapper replacement.
- `apps/server/src/routers/lambda/__tests__/user.test.ts` — **Yes**, corresponding brief-required test adaptation.
- `apps/server/src/modules/AgentRuntime/adapters/serverCallLlmContextBuilder.ts` — **Yes**, batch replacement and `await import()` swap.
- `apps/server/src/modules/AgentRuntime/adapters/serverCallLlmContextBuilder.topicRefs.test.ts` — **Yes**, brief-required test.
- `apps/server/src/services/aiAgent/index.ts` scoped persona import/read — **Yes**, one import and memo replacement.
- `packages/context-engine/src/engine/topicReference/index.ts` — **Yes**, export-only additions.
- `packages/context-engine/src/engine/topicReference/resolveTopicReferencesBatch.ts` — **Yes**, brief-authorized batch helper.
- `packages/context-engine/src/engine/topicReference/__tests__/resolveTopicReferences.test.ts` — **Yes**, batch coverage.
- `packages/database/src/models/message.ts` — **Yes**, single-call-site batch helper; semantic blockers above remain.
- `packages/database/src/models/topic.ts` — **Yes**, single-call-site batch helper.
- `packages/database/src/models/user.ts` — **Yes**, single-call-site batch helper.
- Three new database model tests — **Yes**, brief-required coverage.

## UNVERIFIED

- Vitest was not run, as required by the read-only review constraint; all reported passing test counts are **unverified**.
- `bunx tsgo --noEmit --incremental false -p tsconfig.json` produced no scoped G3 diagnostics, but failed on unrelated G2/F4 working-tree files; an entirely clean type check is **unverified**.
- PGlite/PostgreSQL execution, query plans, timing, and reported query-count/load reductions were not reproduced.