# G3d — round-4 rework after REVIEW_G3_round3.md. Same tree, you are still G3.

Review: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/reviews/REVIEW_G3_round3.md — B1/B3 closed; one BLOCKER left,
accepted:

- `packages/database/src/models/message.ts` (~line 499): the SQL predicate `content ~ '\S'` is not equivalent to JavaScript
  `content.trim() !== ''`. ECMAScript trims its own WhiteSpace + LineTerminator set (U+0009-U+000D, U+0020, U+00A0, U+1680,
  U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF), while PostgreSQL's `\S` is the locale/POSIX `space` class, so
  five NEWER rows made only of U+FEFF / U+00A0 / U+2028 can pass SQL ranking, consume the per-topic quota and then be dropped by
  `toRecentMessages`, hiding an older valid message.
- Fix: reject ECMAScript-whitespace-only content BEFORE `ROW_NUMBER()` — build the predicate from explicit escapes rather than literal
  characters, e.g. `regexp_replace(content, '[' || E'\\u0009\\u000A...' || ']', '', 'g') <> ''` or
  `btrim(content, E'\\u0009\\u000A...') <> ''` with the full code-point list above. Verify PGlite accepts the escape form you pick
  (test it), and keep the JS-side filter as is.
- Add a regression test: five NEWER messages whose content is only U+FEFF / U+00A0 / U+2028 must not consume the per-topic quota — the
  older valid message must still be returned.

Rerun `cd packages/database && bunx vitest run --silent='passed-only' src/models/__tests__/messages/message.queryRoleContentByTopicIds.test.ts`
plus the context-engine topicReference tests, and `bunx tsgo --noEmit -p tsconfig.json` once. Update phase2/reports/G3.md "Round 4".
Final message: 3 lines.
