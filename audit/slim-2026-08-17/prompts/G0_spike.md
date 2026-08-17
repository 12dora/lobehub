# G0 — Build spike: does lazy() split server chunks? Who eagerly imports the heavy deps?

You are a measurement agent. Worktree: /Users/konata/code/AIHub-worktrees/spike (detached at main d1fc9295d2,
deps installed, .env.development copied). You may modify files THERE freely (it is throwaway). Never touch
/Users/konata/code/AIHub or /Users/konata/code/AIHub-worktrees/slim.

Background (measured, see audit/slim-2026-08-17/explore/E1_runtime.md
sections B1/B2/C4/C5): the Docker standalone server boots by requiring 1876 modules / 78MB of
`.next/server/chunks` (63% of all chunk bytes), incl. six 4.14MB `[root-of-the-server]__*.js` mega-chunks
that contain bot adapters, model-bank, i18n, mihomo client, tiktoken markers. Every 1MB of chunk ≈ 2.5MB RSS.
We plan to (a) wrap optional tRPC sub-routers in `@trpc/server`'s `lazy(() => import('./x'))` and
(b) move fork startup side effects out of `apps/server/src/enterprise/routers/platform.ts:51-81` and turn
static imports of heavy deps into `await import()`. Before the other agents rely on this, we need facts.

## Tasks
1. Baseline build: `cd /Users/konata/code/AIHub-worktrees/spike && DOCKER=true NODE_OPTIONS=--max-old-space-size=7168 bunx next build`
   (Only the Next server build is needed — do NOT run the three vite SPA builds. If `next build` insists on
   the SPA templates, run `bun run build:spa:raw` once or stub what it needs — note what you did.)
   Record: total size / count of `.next/server/chunks`, sizes of the `[root-of-the-server]__*` chunks, and
   the module graph for the lambda tRPC route: run the standalone server (`node .next/standalone/server.js`
   with the env from .env.development, PORT free e.g. 3033) and dump `Object.keys(require.cache)` filtered to
   `.next/server/chunks` right after boot and after one `GET /trpc/lambda/platform.getPublicSnapshot`
   (use `NODE_OPTIONS=--inspect-port=0` + `kill -USR1` + a CDP script, or simply add a temporary debug
   route / a `process.on('SIGUSR2')` handler in the standalone server.js that writes the list to a file — it
   is a throwaway tree). Compute total loaded chunk bytes.
2. Experiment A (lazy routers): in `apps/server/src/routers/lambda/index.ts` replace 3–4 optional routers
   (`knowledgeBase`, `image`, `market`, `agentSignal`) with `lazy(() => import('./knowledgeBase'))` etc.
   (import `lazy` from `@trpc/server` — verify the export exists in node_modules/@trpc/server 11.18). Rebuild,
   re-measure (1). Report: did the router code move out of the boot-loaded set / root mega-chunks? by how
   many bytes? Any type errors (`AdminRouter`/`LambdaRouter` inference, `_def.procedures` consumers such as
   apps/server/src/enterprise/security/policy/adminProcedureAuthorization/reconcile.ts, openapi generation)?
   Any runtime error on first call of a lazy router?
3. Experiment B (bots + fork side effects): comment out the `GatewayService` block in `src/instrumentation.ts`
   and the 14 side-effect lines `apps/server/src/enterprise/routers/platform.ts:51-81` (and their imports).
   Rebuild, re-measure. Report chunk/boot-set delta and RSS delta (`process.memoryUsage().rss` at boot,
   3 samples each).
4. Provenance of heavy boot-time deps: using the loaded-module list of the baseline, find the import chains
   that pull `sharp`, `@aws-sdk/client-s3`, `xlsx`, `@xmldom/xmldom`, `discord.js`, the 11 search providers
   (`apps/server/src/services/search/impls/index.ts`) and the 28 `builtin-tool-*` packages into the boot set.
   Method: build with source maps if feasible (`productionBrowserSourceMaps` is for the client; for server try
   `experimental.serverSourceMaps` in next.config or grep the chunk for the module ids / `__turbopack_context__`
   module path strings — Turbopack keeps `[project]/...` path strings in server chunks), or bisect by
   temporarily removing imports. Deliver a table: dep → first importer file:line on the boot path → suggested
   fix (lazy import at X / router lazy / move to worker).
5. Also verify E3's open question quickly: why `/app/src`, `/app/packages`, `apps/desktop/build` end up in the
   standalone output — inspect `.next/standalone` tree and `.next/server/*.nft.json` after the baseline build,
   and try adding `outputFileTracingExcludes: { '*': ['./dist/**','./apps/desktop/**','./apps/cli/**','./e2e/**','./tests/**','./**/*.tsbuildinfo'] }`
   for the Docker branch in `next.config.ts` (mirror the existing `isVercel` block) → does the standalone
   folder shrink and does `node .next/standalone/server.js` still boot? Report sizes before/after.

## Output
Write `audit/slim-2026-08-17/explore/G0_spike.md`
(≤200 lines, Chinese prose OK, numbers first): A. verdict for lazy() (works / doesn't; bytes saved; caveats),
B. verdict for side-effect removal, C. provenance table (dep → importer file:line → fix), D. tracing-excludes
result, E. anything that broke and how. Time budget ~60–75 min including two rebuilds; if a rebuild exceeds 20
min, skip experiment B and say so. Final message = report path + section A verbatim.
