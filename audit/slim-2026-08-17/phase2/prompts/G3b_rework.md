# G3b — rework after codex review (REVIEW_G3.md). Same tree, you are still G3.

Review: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/reviews/REVIEW_G3.md — read it fully.
Commander verdicts (all accepted unless noted):

1. (BLOCKER 1) `getUserStateBundle` counts must keep the exact predicates of the calls they replace — including
   `workspace_id IS NULL` (personal mode) for messages/sessions and any other filter `countUpTo`/`hasMoreThanN` applied. Diff the old
   call sites line by line; add a test with same-user workspace rows proving they do not flip `hasConversation` / guide flags.
2. (BLOCKER 2) Restore upstream `UserModel.getUserState` byte-for-byte (git checkout the method body from HEAD). `getUserStateBundle`
   stays a separate additive method (single-call-site from the router's batch helper). Any other caller of getUserState must be unchanged.
3. (BLOCKER 3) `personaReadMemo.ts`: `import type { UserPersonaModel }` only; do the `await import('@/database/models/userMemory/persona')`
   inside the single-flight loader AFTER the `isModuleEnabled('memory')` check. Memory off ⇒ nothing from that graph loads.
4. (BLOCKER 4) Remove the listener registry / write-path changes from `packages/database/src/models/userMemory/persona.ts` entirely
   (git checkout the file to HEAD). Invalidation = TTL only. Set the memo TTL to 15s (persona edits from the memory extractor or the
   user must show within one short window); document that in the memo file header. Do NOT add a fork post-commit seam.
5. (BLOCKER 5) `packages/context-engine/src/engine/topicReference/resolveTopicReferences.ts`: restore the legacy resolver byte-for-byte
   (git checkout to HEAD), and add the batch implementation as a NEW exported function in a new sibling file
   (e.g. `resolveTopicReferencesBatch.ts`, exported from the topicReference index with a one-line export). The server adapter calls the
   batch function; nothing else changes. Keep the batch tests (adjust imports).
6. (MAJOR 6) `MessageModel.queryRoleContentByTopicIds`: push the role/content filters and a per-topic row cap into SQL (window
   `ROW_NUMBER() OVER (PARTITION BY topic_id ORDER BY created_at DESC)` ≤ N, or a lateral join) — output chronological per topic exactly
   like the legacy path (5 most recent? read the legacy `resolveTopicReferences` to get the exact N and ordering) and add a large-topic
   regression test (e.g. 50 rows in one topic → only N returned).
7. (MAJOR 7) Fix the two TS2352 casts in `serverCallLlmContextBuilder.topicRefs.test.ts` (cast through `unknown` or type the mock).

Then rerun the same test commands as in your report + `bunx tsgo --noEmit -p tsconfig.json` ONCE (grep the output for your files only —
other agents' in-progress files may error). Update `phase2/reports/G3.md` with a "Round 2" section (what changed per finding, tests).
Final message: 8 lines.
