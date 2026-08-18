# G3 — P3: fixed per-message / per-page-load DB cost (load dimension)

Read /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/prompts/COMMON_RULES.md first (you are G3).
Then HANDOFF §1 P3: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/HANDOFF.md, and the referenced
`explore/E5_request_path.md` B6/B9 (rows 10 and 12 of its table are the ones still open) + `reports/V2.md` §3 (load table: ~23 xact/s
at 20 concurrent streaming chats), and the phase-1 precedent `UserSettingsReadMemo` in
`apps/server/src/enterprise/services/settings/runtimeSettingsAdapter.ts` (per-request memo pattern) and `reports/G4.md`.
REPO = /Users/konata/code/AIHub-worktrees/slim2.

Rule 2 of COMMON_RULES is the hard constraint here: every item below touches UPSTREAM files — each may receive one/two-line
changes only (a memo wrapper, a batch call replacing N calls, a guard). Put logic in fork files
(`apps/server/src/enterprise/**` or a small helper next to the model in packages/database if it is a pure batch query).

## Items
1. `apps/server/src/routers/lambda/user.ts` `getUserState` (~line 122–170): a 5-way `Promise.all` (getUserState + countUpTo /
   hasMoreThanN / referral / subscription …). Read what each result is used for. Merge what can be merged into ONE query (a batch
   helper on `UserModel`, e.g. `getUserStateBundle`) or gate the ones only needed under a flag/module (memory / market / subscription
   off ⇒ skip). Keep the returned `UserInitializationState` shape byte-identical.
2. `apps/server/src/modules/AgentRuntime/adapters/serverCallLlmContextBuilder.ts` ~110–131 → `resolveTopicReferences`
   (`packages/context-engine`): per referenced topic 2× `findById` + 1× full `messageModel.query`. Replace with batch lookups
   (one `WHERE id IN (...)` for topics, one for messages, keep ordering) — implement the batch in the model/helper layer, and change the
   adapter/context-engine call to the batch form with a minimal diff. Preserve behaviour for missing/forbidden topics.
3. `apps/server/src/services/aiAgent/index.ts` persona lookup (grep `UserPersonaModel` / `persona`; ~3596–3620): one query per message
   → per-request memo (reuse the `UserSettingsReadMemo` idea: a fork helper `enterprise/services/memory/personaReadMemo.ts` keyed by
   userId with a short TTL, e.g. 30s, plus invalidation on persona write if a write path exists in the same process — find it), and
   skip entirely when the `memory` module is off (`isModuleEnabled('memory')` from `enterprise/services/moduleSettings`). G1 works in
   the same file on import lines / tool registry — touch ONLY the persona region; if you need an import line, add it as a separate
   line and note it.
4. `packages/context-engine/src/pipeline.ts` (~50 sequential processors): MEASURE ONLY — instrument locally (do not commit
   instrumentation) with a fake context to get per-processor wall time and list which processors do I/O; write the dependency
   analysis in your report (which contiguous segments have no data dependency and could run in parallel, expected gain in ms). Do NOT
   change pipeline.ts in this batch.
5. Look for one more per-message fixed cost in the same path (E5 table rows) that is a one-liner memo — if found, do it and report.

## Verify
- Tests next to each change (batch helper unit tests with PGlite in packages/database; adapter test with mocked models; persona memo
  test incl. TTL/invalidation and module-off skip; getUserState test asserting identical output shape).
- `cd REPO && bunx vitest run --silent='passed-only' apps/server/src/routers/lambda/user.test.ts apps/server/src/modules/AgentRuntime`
  (adjust to real test paths), `cd REPO/packages/context-engine && bunx vitest run <files>`,
  `cd REPO/packages/database && bunx vitest run <files>`.
- Numbers in the report: queries per message before/after for items 2–3 (count from code), queries per `getUserState` before/after,
  pipeline per-processor timing table (item 4).

Report → REPO/audit/slim-2026-08-17/phase2/reports/G3.md (≤120 lines).
