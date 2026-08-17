# Explorer common rules (batch "slim": LobeHub Enhanced deployment slimming / optional modules)

Context: this repo is an enterprise fork (AIHub / "LobeHub Enhanced") of upstream lobehub/lobehub
(Next.js 16 + SPA + tRPC + Drizzle/PG). Fork-only code lives mostly in `apps/server/src/enterprise/`,
`src/enterprise/`, `src/features/Admin*`, `packages/business*`, `docker-compose/enhanced/`, plus
`platform*`-named tables/services. Everything else is upstream code that we periodically merge from.

User feedback: **the deployment is "very heavy" — lots of CPU and memory**. Goal of the batch: a
"trim + optional-module deployment" plan:
  1) find the hotspots (which modules cost the resources);
  2) keep future **upstream merges easy** — we WILL touch upstream files this round, so changes must be
     small, localized, ideally a few well-named seams (registry / guard / lazy import) rather than
     scattered edits;
  3) let operators pick which modules to disable via docker container params (env) and/or a first-run
     graphical setup wizard;
  4) the admin panel must degrade gracefully for disabled modules (hide / show a "module disabled"
     notice; never a broken page or 500);
  5) list algorithmic / implementation-level optimizations for hot paths as well.

Your role: **read-only explorer**. Produce one Markdown report at the given path. Never modify repo
files (scripts / temp files under the scratchpad are fine).
Repo root: /Users/konata/code/AIHub (main git tree; other sessions may commit concurrently — never
`git stash` / `checkout` / `reset`).
Scratchpad: audit/slim-2026-08-17/

Known facts (cite, no need to re-verify):
- Local demo: container `aihub-demo-app` (image aihub:demo, 1.72GB; host 127.0.0.1:3010 → container
  3210), compose at ~/.local/share/aihub/demo/docker-compose.app.yml; depends on the aihub-dev infra
  (containers aihub-dev-postgres = paradedb pg17 host port 5433, aihub-dev-redis 6380, aihub-dev-rustfs
  9010, aihub-dev-searxng), docker network `aihub-dev_aihub-dev`.
- Processes in the container: pid1 `/bin/node /app/startServer.js` → `next-server (v16.3.0)` RSS≈700MB
  (idle CPU≈4-5%) → child `mihomo` (network-proxy engine).
- Upstream feature flags: `packages/app-config/src/featureFlags/schema.ts` (FEATURE_FLAGS env:
  market / knowledge_base / ai_image / speech_to_text / changelog …); server side reads them in
  `apps/server/src/featureFlags/index.ts` (Redis/Env RuntimeConfigProvider).
- Enterprise flags: `apps/server/src/enterprise/featureFlags/` (ENABLE_PLATFORM_ADMIN /
  ENABLE_PLATFORM_MANAGED_AI / _SKILLS / _CONNECTORS / _AGENTS / ENABLE_PLATFORM_SETTINGS_POLICY /
  ENABLE_RUNTIME_BRANDING / ENABLE_DATABASE_OIDC …, all default ON).
- Server startup seams: `src/instrumentation.ts` (register(): platform admin bootstrap / RBAC seeding,
  IdP bootstrap, instance heartbeat, GatewayService, optional OTel); `apps/server/src/enterprise/jobs/`
  (persistentWorkerRuntime/Scheduler, auditRetention/Export, agentRollout, secretRewrap,
  sharedOAuthKeepalive, brandingAssetCleanup, instanceRegistryCleanup, idpTestAttemptCleanup); Docker
  entry `scripts/serverLauncher/startServer.js` (runs /app/docker.cjs migrations, then server.js).
- Deployment: `docker-compose/enhanced/` (app + paradedb + redis + rustfs + mc-init + lkg-init),
  `docker-compose/deploy/` (upstream-style + searxng), root `Dockerfile`.
- Workflow: `bun run check <files>`; never run the full `bun run test`; `packages/database` tests run
  from inside that directory.

Report requirements (hard):
- Every claim carries evidence: `path:line` (clickable) or a command-output excerpt; mark guesses
  as [guess].
- Structure: A Summary (≤15 lines, for the commander to decide on) / B Findings by importance /
  C Recommended seams (fewest edits, upstream-merge friendly — say explicitly whether each seam is in
  upstream or fork-only code) / D Explicit "do not touch" list + risks / E Unverified items that need
  a real-machine check.
- Numbers first (RSS / heap / loaded chunk bytes / timer periods / query counts); no vague "probably heavy".
- No implementation code (interface / data-structure pseudocode is fine). Keep it under 400 lines.
- Write in Chinese prose with English technical terms (the commander and user read Chinese).
