# G0b — Measure round 1 (spike tree now contains the batch's working-tree changes)

Same worktree as before: /Users/konata/code/AIHub-worktrees/spike. It was reset to HEAD and then the 177 changed/new files
of the batch (worker registry, lazy routers, module gates, tracing excludes, hot-path caches, F1/F2 client work) were
copied in. Read your previous report audit/slim-2026-08-17/explore/G0_spike.md
to recall the tooling (env, SPA template stubs, Module._cache dump, boot RSS sampling). Re-apply the stubs you need.

## Measure (one build, several boots)
1. `DOCKER=true NODE_OPTIONS=--max-old-space-size=7168 bunx next build` (server only, as before). Note: `next.config.ts` now
   has Docker `outputFileTracingExcludes` (specific globs, not `dist/**`) — record whether `.next/standalone` still contains
   `src/`, `packages/`, `apps/server` and its total size.
2. Boot the standalone server 3 times per configuration with the .env.development env + `PORT=3033`, wait for Ready + 15s,
   sample `process.memoryUsage()` (rss/heapUsed) and the loaded `Module._cache` chunk set (count/bytes) — same method as
   before — then hit `GET /trpc/lambda/platform.getPublicSnapshot` and re-sample after 10s. Configurations:
   a. default (no LOBE_* env)  b. `LOBE_MODULE_PRESET=standard`  c. `LOBE_MODULE_PRESET=minimal`
   d. default + `ENABLE_BOT_GATEWAY=0` is launcher-only; instead for the boots below just observe whether GatewayService starts
   (log line) under (b)/(c).
   Also record for each: boot time to Ready, DB xact/s over 60s idle (`SELECT xact_commit FROM pg_stat_database` delta on the
   dev DB used by .env.development), and whether the log shows `[modules] worker … skipped`.
3. Verify functionally on config (c) minimal: `GET /trpc/lambda/knowledgeBase.getKnowledgeBases` (or any query of a lazy
   router) → expect HTTP 403 with body containing `PLATFORM_MODULE_DISABLED` (NOT 404, NOT 500); on config (a) the same call
   → 401/200 (auth), not 500. Also `GET /api/agent/gateway/start` (POST) on (c) → 200 `{disabled:true}`.
4. Provenance recheck: with the batch applied, is `discord.js` / `sharp` / `@aws-sdk/client-s3` still in the boot set on (a)?
   on (c)? (count of paths in Module._cache).
5. Optional if time: rebuild once with `experimental.preloadEntriesOnStart: false` added to next.config for Docker and repeat
   (a): boot RSS/chunk set + first-request latency of `platform.getPublicSnapshot`.

## Output
Write audit/slim-2026-08-17/explore/G0b_measure.md
(≤150 lines): A. table config × {rss boot, rss after first request, chunk bytes, modules count, boot time, idle xact/s, gateway
started?}; B. functional checks; C. provenance; D. preloadEntriesOnStart result (or "not run"); E. anything broken (with the
exact error). Numbers first. Time budget ~60 min. Final message = path + section A verbatim.
