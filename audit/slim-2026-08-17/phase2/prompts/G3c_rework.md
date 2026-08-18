# G3c — round-3 rework after REVIEW_G3_round2.md. Same tree, you are still G3.

Review: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/reviews/REVIEW_G3_round2.md — three BLOCKERs, all accepted:
1. `MessageModel.queryRoleContentByTopicIds`: add `thread_id IS NULL` (the legacy `query()` path applied `matchThread(undefined)`); test with
   newer child-thread messages present.
2. Same query: whitespace filter must match JS `content.trim() !== ''` — use a regex predicate before ranking (`content ~ '\S'` in PG /
   PGlite; verify PGlite accepts it, else `btrim(content, E' \t\n\r\f\v') <> ''`); test with whitespace-only rows in the newest positions.
3. `personaReadMemo.ts` and `userInfoReadMemo.ts`: never evict an in-flight slot — keep in-flight promises in a separate uncapped map
   (or mark entries and skip them in eviction); resolved entries keep the LRU cap. Add a saturation test (cap+1 concurrent distinct keys →
   the evicted-candidate key still single-flights).
Rerun the same tests + `bunx tsgo --noEmit -p tsconfig.json` once (grep your files). Update phase2/reports/G3.md "Round 3". Final: 4 lines.
