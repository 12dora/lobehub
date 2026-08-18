# VERDICT: REWORK

## FINDINGS

Round-2 status: B1 is closed in code (`thread_id IS NULL` precedes ranking); B3 is closed in code (separate uncapped in-flight maps). B2 remains open:

1. **BLOCKER** · [packages/database/src/models/message.ts:499](/Users/konata/code/AIHub-worktrees/slim2/packages/database/src/models/message.ts:499) · `content ~ '\S'` is not byte-equivalent to JavaScript `content.trim() !== ''`. PostgreSQL’s `\S` is the inverse of its locale-sensitive POSIX `space` class, whereas ECMAScript trims its defined Unicode WhiteSpace and LineTerminator set—including characters such as U+FEFF. Five newer U+FEFF/NBSP-only rows can therefore pass SQL ranking, consume the five-row quota, and then be discarded by `toRecentMessages`, hiding older valid messages. [PostgreSQL regex definition](https://www.postgresql.org/docs/15/functions-matching.html); [ECMAScript trim definition](https://tc39.es/ecma262/multipage/text-processing.html). Replace the predicate with an explicit ECMAScript-whitespace-only rejection before `ROW_NUMBER()`, and add a regression with five newer U+FEFF/NBSP/Unicode-separator rows. **[verified]**

## METRICS

- Files reviewed: **10** — 2 tracked modifications and 8 untracked files.
- Upstream files touched:

  - `packages/database/src/models/message.ts` — **Rule 2: Yes**, additive batch helper called from one adapter site.
  - `packages/database/src/models/__tests__/messages/message.queryRoleContentByTopicIds.test.ts` — **Yes**, brief-required coverage for that helper.
  - `packages/context-engine/src/engine/topicReference/resolveTopicReferencesBatch.ts` — **Yes**, isolated batch helper.
  - `apps/server/src/modules/AgentRuntime/adapters/serverCallLlmContextBuilder.ts` — **Yes**, batch replacement plus `await import()` swap.

## UNVERIFIED

- Vitest/PGlite was not run, per the read-only review constraint; the author’s reported pass counts and new concurrency/database tests are unverified.
- PostgreSQL execution plans, query-count reductions, and runtime cache timing were not reproduced.
- `bunx tsgo --noEmit --incremental false -p tsconfig.json` was run and emitted no diagnostics.