# G4 — P1 (part 2): cut four heavy seams on the first-chat-request graph that G1 does not own

Read /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/prompts/COMMON_RULES.md first (you are G4; your ownership
set is defined HERE, not there). Then read the explorer's report
/Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/reports/E1.md fully (static import-graph attribution of the
first chat request; its scanner lives in /private/tmp/claude-501/-Users-konata-code-AIHub/9345b506-f4c4-43e9-8306-200ae4e11e70/scratchpad/e1/ —
reuse it for before/after numbers). REPO = /Users/konata/code/AIHub-worktrees/slim2. G1 (running in parallel) owns
`apps/server/src/services/{toolExecution,aiAgent}/**` and `packages/builtin-tool*/src/index.ts` — do NOT edit those; you get the seams
below.

## Your ownership (exclusive)
- packages/agent-tracing/** (package.json exports + src/index.ts + cli), and the import lines in packages/llm-generation-tracing/src/**
  that consume agent-tracing viewer exports (if any).
- packages/memory-user-memory/src/services/extractExecutor.ts (+ any sibling that imports `@lobechat/observability-otel/node` at top level).
- apps/server/src/globalConfig/** (the `@/libs/better-auth/utils/server` import only) — phase-1 G4 already memoised this file; keep that.
- apps/server/src/enterprise/services/skillCatalog/validator.ts (the `@lobechat/device-control` import) and its tests.
- apps/server/src/services/heterogeneousAgent/index.ts (only the `@lobechat/agent-tracing` import line if needed).

## Seams (from E1; verify each before editing)
1. E1 seam #1: `packages/agent-tracing/src/index.ts` re-exports `./viewer` (terminal renderer → `gpt-tokenizer`, 56 MB in node_modules,
   62k source) although the server only needs `parseOperationId`/`ISnapshotStore` (`apps/server/src/services/heterogeneousAgent/index.ts:2`).
   Fix: move the viewer exports out of the root barrel to a subpath export `"./viewer": "./src/viewer/index.ts"` in package.json (keep the
   CLI working: it imports viewer directly), update every consumer of those six functions (`grep -rn "renderSnapshot\|renderSummaryTable\|
   analyzeAgentSignal\|renderAgentSignal\|renderStepDetail\|renderMessageDetail" packages apps src`) to the subpath. Also check
   `src/analysis/toolFeedback.ts` (uses gpt-tokenizer) is not reachable from the root barrel after the change.
2. E1 seam #2: `packages/memory-user-memory/src/services/extractExecutor.ts:3,10,11` imports `@lobechat/observability-otel/{api,modules/…,node}`
   at top level → the full OTel Node SDK (~4.9 MB, 7 packages) is loaded as soon as the memory server runtime is (G1 makes that runtime
   lazy, but the memory tool is in `defaultToolIds`, so it still loads on the first tool call). Make the `/node` (and `/modules/…` if heavy)
   imports lazy at the call site (`await import()` inside the function that records the span), keeping `SpanStatusCode` (tiny `/api`) static
   if it is a plain enum. Check `@lobechat/observability-otel/node` — if it is a thin wrapper that only re-exports light helpers, measure
   and skip.
3. E1 seam #4: `apps/server/src/globalConfig/index.ts:13` `parseSSOProviders` from `@/libs/better-auth/utils/server` → 63 files + nodemailer /
   resend / bcryptjs / @better-auth/* (251k). Check what `parseSSOProviders` does; if it is a pure string parser, import it from its own
   small module (or copy the pure function into a fork helper `apps/server/src/enterprise/…` — no: prefer a subpath import of the pure
   module if one exists) — one-line import change. If the auth graph is loaded anyway on every request by tRPC context, measure (E1
   scanner) and report instead of changing.
4. E1 seam #6: `apps/server/src/enterprise/services/skillCatalog/validator.ts:1` `validateInlineSkillResourcePaths` from
   `@lobechat/device-control` → local-file-shell 46 files + fast-glob/execa. Make it `await import()` at the call site (fork file, free
   hand) or import the pure validator from its own module inside device-control if the package exposes a subpath.

## Verify
- E1 scanner before/after (files / KB / externals) for the first-chat roots — the report must show the delta per seam.
- Tests: `cd REPO/packages/agent-tracing && bunx vitest run` (if configured; else `bun run check --test`), packages/memory-user-memory
  tests near extractExecutor, `apps/server/src/globalConfig` tests, skillCatalog validator tests; lint your files
  (`cd REPO && bun run check --lint <files>`).
- Type check of the touched packages: `bunx tsgo --noEmit -p tsconfig.json` is expensive (~1 min, machine is loaded) — allowed ONCE at
  the end.

Report → REPO/audit/slim-2026-08-17/phase2/reports/G4.md (≤100 lines): per seam what changed (file:line), delta from the scanner,
tests, upstream files touched (each must be a one-line/mechanical change), anything skipped and why.
