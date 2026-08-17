# E1 — Server runtime hotspots, measured (boot / idle / memory composition)

Read EXPLORE_RULES.md (same directory) first. Write the report to `../explore/E1_runtime.md`.

Task: answer with **real measurements** "where do the idle 700MB RSS and 4-5% CPU of next-server come
from", and produce hotspot lists for the boot phase and the idle phase.

## Allowed operations
- You may start one **temporary perf container** (do NOT touch aihub-demo-app):
  - Copy the DB first: `docker exec aihub-dev-postgres sh -c 'createdb -U postgres lobechat_perf && pg_dump -U postgres lobechat_demo | psql -q -U postgres lobechat_perf'` (if createdb fails because it exists, just reuse it).
  - `docker run -d --name aihub-perf --network aihub-dev_aihub-dev --env-file /Users/konata/code/AIHub/.env.development --env-file ~/.local/share/aihub/demo/.env.platform -p 127.0.0.1:3019:3210 -p 127.0.0.1:9229:9229 <every `environment:` entry of the demo compose copied as -e, except: DATABASE_URL → .../lobechat_perf, REDIS_URL=redis://aihub-dev-redis:6379/3, AUTH_COOKIE_PREFIX=aihub-perf, APP_URL=http://localhost:3019> -e NODE_OPTIONS="--inspect=0.0.0.0:9229 --heapsnapshot-signal=SIGUSR2" aihub:demo`
    (compose: ~/.local/share/aihub/demo/docker-compose.app.yml). Optional: skip the `extra_hosts` line.
  - startServer.js spawns next-server as a child; NODE_OPTIONS is inherited, so `--inspect` on a fixed
    port may collide between parent and child. If so, use `--inspect-port=0`, or enable the inspector on
    demand with `kill -USR1 <next-server pid>` inside the container and drive it from a node script run
    via `docker exec` (Node 22 has a global WebSocket) speaking CDP against ws://127.0.0.1:9229:
    `Profiler.enable/start/stop` (sample 60s idle), `HeapProfiler.takeHeapSnapshot`, `Runtime.evaluate`
    for `process.memoryUsage()`, `Object.keys(require.cache)` (normalize and aggregate by
    `.next/server/chunks` file size), `process.getActiveResourcesInfo()`,
    `process._getActiveHandles().length`.
  - When done: `docker rm -f aihub-perf`; keep the lobechat_perf DB for later reuse.
- Sampling: `docker stats --no-stream` in a 60s loop, `/proc/<pid>/stat` deltas, container logs.

## Questions to answer
1. Boot timeline to "Ready" (migration / instrumentation register segments; log timestamps).
2. Source of the idle 4-5% CPU: which timers / pollers run (align CPU-profile top-N self-time functions
   with source files; then cross-check statically `setInterval|setTimeout.*loop|cron|schedule` on the
   server startup path and in enterprise/jobs for period + guard predicate); Redis polling, heartbeat,
   instance status, network-proxy engine supervision / subscription refresh, gateway, moderation, agent
   signal, etc. Produce a **period table** (name / interval / file:line / can it be switched off by a
   flag / idle cost).
3. Composition of the 700MB RSS: heap used vs external vs arrayBuffers vs rss; heap-snapshot retained
   size Top 20 aggregated by script/chunk; total + Top 20 server chunks loaded at boot (map names to
   features: model bank, locales, tiktoken, pdf, agent runtime, mcp, desktop, bots …); which are
   "eagerly loaded although their route was never hit" (instrumentation / top-level side-effect imports).
4. Resident cost of the mihomo child, GatewayService, and any worker_threads (moderation regex worker etc.).
5. A rough table "if module X is disabled, expected RSS/CPU saving" (measured or estimated from chunk
   sizes), plus **algorithm / implementation-level optimizations** (idle polling → event-driven, cache
   TTLs, eager import → lazy, merging concurrent queries, …).

Section A must state directly: Top 5 memory contributors, Top 5 CPU contributors, and where the on/off
seam for each lives (upstream vs fork-only file).
