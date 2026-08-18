# COMMON RULES — "slim" phase 2 (deployment slimming, round 2), LobeHub Enhanced

You are one coding agent in a batch of ~7 running IN PARALLEL in the SAME git worktree. Read this whole
file, then your own brief. Deviating from the file-ownership rules breaks other agents' work.

## Repo / branch
- REPO = /Users/konata/code/AIHub-worktrees/slim2  (branch `feat/slim-phase2`, based on origin/main bd40b3db3a).
  This is the ONLY tree you may touch. Never touch /Users/konata/code/AIHub (another session works there) nor
  /Users/konata/code/AIHub-worktrees/slim. `pnpm install` is already done.
- Read REPO/AGENTS.md first (tech stack, `bun run check`, i18n rules, base-ui component priority).
- Phase-1 context: REPO/audit/slim-2026-08-17/HANDOFF.md is the entry point (your task = one "P*" section there);
  it links the measured exploration reports (`explore/E1..E5`, `explore/G0*`), the implementation reports (`reports/*`)
  and the phase-1 briefs (`prompts/*`). Trust measured numbers over guesses, but verify against the code before editing.
- Phase-1 invariants still hold (read HANDOFF §3 "坑" once): all routers always mounted (`lazyRouter`/`moduleRouter`,
  `PLATFORM_MODULE_DISABLED` never NOT_FOUND); workers start only from `enterprise/bootstrap/workersBootstrap.ts`
  and honour the boot module view; user-facing `platform.*` reads keep "stable empty" semantics; state shared between
  `instrumentation.ts` and route handlers lives on `globalThis`; `outputFileTracingExcludes` never bare `dist/**`.

## Non-negotiable rules
1. Behaviour when nothing is configured must stay byte-for-byte today's behaviour (default = full, everything on).
2. Upstream-merge friendliness: touching an upstream file (anything outside `apps/server/src/enterprise/**`,
   `src/enterprise/**`, `packages/const/src/platform/**`, `packages/types/src/platform/**`,
   `packages/database/src/{schemas,models}/platform/**`, `docker-compose/enhanced/**`, `docs/enterprise/**`,
   `plugins/vite/**` fork files, `src/libs/next/config/docker*.ts`) is allowed ONLY as: one-line guards, one-line
   replacements, a wrapper/memo around an existing function, a batch helper called from one place, or an
   `await import()` in place of a static import. Put logic in fork files and import it. Keep upstream diffs tiny and
   mechanical; never reformat / re-sort / restructure upstream files. Do not add new upstream files unless the brief says so.
3. Every cache has a TTL and/or an explicit invalidation (identity/content-addressed memos are fine — see the
   phase-1 rework verdicts in `prompts/*b_rework.md`).
4. Do not change module ids / presets / router shapes / tRPC procedure names. Do not add tRPC procedures unless your
   brief says so (registries `security/policy/**` count them: 219 total / 102 queries / 117 mutations today).
5. Every optimisation must be measured or reasoned with numbers in your report (before/after: RSS, xact/s, module
   count, bytes, request count) — the commander decides with those numbers.

## Ownership (exclusive file sets — if you must touch a file owned by someone else, STOP and note it in your report;
## do NOT edit it)
- E1 (explorer, read-only; writes only its report): whole repo read; no edits.
- G1 builtin-tools / first-chat-request graph: packages/builtin-tools/**, packages/builtin-tool-*/src/index.ts (export
  shape only), apps/server/src/services/toolExecution/**, apps/server/src/services/aiAgent/** EXCEPT the persona/user
  settings read owned by G3 (coordinate by region: G1 touches only import lines and tool-registry code in
  aiAgent/index.ts; G3 touches only the persona lookup — if both need the same lines, G1 wins and G3 notes it),
  apps/server/src/enterprise/guards/toolModuleGate.ts, apps/server/src/routers/lambda/aiAgent*.ts (only if needed).
- G2 jobs dispatcher + heartbeat merge: apps/server/src/enterprise/bootstrap/workersBootstrap.ts,
  apps/server/src/enterprise/jobs/**, the six platform_jobs worker files
  (services/agentCatalog/*rollout*, services/secrets/*rewrap*, services/audit/*export*/*retention* workers,
  services/connectorCatalog/{runtimeAuditWorker,secretCleanupWorker}.ts — verify the exact paths),
  packages/database/src/models/platform/platformJobs*.ts (+ new batch query), apps/server/src/enterprise/services/
  platformInstance/heartbeatRuntime.ts, apps/server/src/enterprise/services/identityProvider/instanceRegistry.ts,
  packages/database/src/schemas/platform/** ONLY if a column is strictly required (prefer none; no migration if avoidable),
  docs/enterprise/modules.md "workers" paragraph.
- G3 per-message fixed cost: apps/server/src/routers/lambda/user.ts (getUserState only), packages/database/src/models/user.ts
  (batch helper only), apps/server/src/modules/AgentRuntime/adapters/serverCallLlmContextBuilder.ts,
  packages/context-engine/src/{topicReference,pipeline}*.ts (topicReference batch; pipeline: MEASURE ONLY, no edit),
  apps/server/src/services/aiAgent/index.ts persona/user-settings read region only, apps/server/src/enterprise/services/
  settings/runtimeSettingsAdapter.ts, packages/database/src/models/userMemory/persona.ts (batch/memo helper only).
- G5 docker layers: Dockerfile (final stage only + tracing), src/libs/next/config/dockerTracingExcludes.ts,
  src/libs/next/config/dockerCanvasTracingIncludes.ts, next.config.ts (docker branch only), scripts/serverLauncher/startServer.js,
  docker-compose/enhanced/**, docs/enterprise/modules.md "image" paragraph, apps/server/src/enterprise/guards/* (ffmpeg gate only if
  needed), the ffmpeg-static import site(s).
- F4 first-screen bundle: vite.config.ts, plugins/vite/**, index.html / SPA templates, PWA/workbox config, the import sites of
  @lobehub/icons / elkjs / parse5 / @pierre/diffs that must become lazy (upstream files: `await import()` / React.lazy only),
  src/libs/swr only if needed.
- F6 client polling: src/enterprise/client/shared/pollIntervals.ts, src/enterprise/client/providers/**,
  src/enterprise/client/features/admin/**/hooks*.ts (poll call sites only), a new src/enterprise/client/shared/useVisiblePoll.ts
  (or similar), src/enterprise/client/**/*.test.tsx for those.
- Commander only: HANDOFF.md, commits, registries, locale files (packages/locales/** — nobody adds i18n keys in this batch unless
  the brief says so), packages/const/src/platform/modules.ts.

## Working rules
- Do NOT commit, do NOT push, do NOT `git stash/checkout/reset`, do NOT run `git add`. Leave your files modified. The commander
  commits per package. Do not delete or move other agents' files.
- Tests: write/adjust vitest tests next to changed code. Run only targeted tests: `cd REPO && bun run check --test <files>` or
  `cd REPO/<pkg> && bunx vitest run --silent='passed-only' <file>`. NEVER run the full `bun run test`. Never run full
  `tsgo`/`tsc` (the commander runs it once at the end) — instead run `bun run check --lint <files>` on your files.
  packages/database tests: `cd REPO/packages/database && bunx vitest run <file>` (PGlite).
- Known red tests on main (ignore): `platform.mount.regression` (getCapabilities fake db), `serverRuntimes/__tests__/memory.test.ts`
  (schemas mock lacks topics), `packages/const layoutTokens.test`; 5s-timeout flakes under load — rerun alone.
- Absolute paths everywhere. zsh does not word-split `$VAR` — write helper scripts in bash.
- Report: when done, write `REPO/audit/slim-2026-08-17/phase2/reports/<YOUR_ID>.md` with: what changed (file list), measured
  before/after numbers, how verified (commands + results), open questions / files you needed but didn't own, and anything the
  commander must do. Keep it ≤120 lines. Your final message = report path + ≤10-line summary.
