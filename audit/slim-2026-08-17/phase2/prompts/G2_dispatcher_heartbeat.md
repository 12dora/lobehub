# G2 — P2 `platform_jobs` merged dispatcher + P6(server) heartbeat merge (fork-only)

Read /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/prompts/COMMON_RULES.md first (you are G2).
Then HANDOFF §1 P2 and P6 (server half): /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/HANDOFF.md, and the referenced
`explore/E1_runtime.md` C2, `reports/G2.md` ("Optional: single dispatcher" — the design sketch), `reports/V1.md` §1 (how xact/s
was measured). REPO = /Users/konata/code/AIHub-worktrees/slim2.

## Current state (verify)
- `apps/server/src/enterprise/bootstrap/workersBootstrap.ts` registers, among others, six `platform_jobs` polling workers:
  auditExport (3s), auditRetention (3s), agentRollout (2s), connectorRuntimeAudit (5s), connectorSecretCleanup (5s), secretRewrap (2s)
  — each `ensure*WorkerStarted()` (files under `apps/server/src/enterprise/jobs/*.ts` and
  `services/connectorCatalog/{runtimeAuditWorker,secretCleanupWorker}.ts`) runs its own `startPersistentWorkerScheduler` loop
  (`apps/server/src/enterprise/jobs/persistentWorkerScheduler.ts`, phase-1 idle backoff: 3 dry ticks → ×2 up to 60s) and its own
  claim query on `platform_jobs` (`packages/database/src/models/platform/job.ts`, `PlatformJobModel`).
- Instance heartbeat: `services/platformInstance/heartbeatRuntime.ts` (30s) and IdP registry heartbeat
  `services/identityProvider/instanceRegistry.ts` (30s) → two writes per instance per 30s.

## Do — P2
1. Add ONE dispatcher (`apps/server/src/enterprise/jobs/platformJobsDispatcher.ts` + test) that owns a single scheduler loop at
   `min(interval)` of the enabled job types, claims a batch of mixed-type jobs in ONE query (`SELECT … FOR UPDATE SKIP LOCKED` on
   `platform_jobs` filtered by `type IN (<enabled types>)` and the existing backlog states — add a batch-claim method to
   `PlatformJobModel` beside the existing per-type claim, keeping the per-type method for callers/tests), then dispatches to the
   existing per-type handler functions (refactor each worker file so its "handle one claimed job" body is an exported function the
   dispatcher can call; keep the old `ensure*WorkerStarted()` exports working — either as thin no-ops that register with the dispatcher,
   or keep them functional but unused; tests reference them).
   - Per-type `didWork` must feed the whole-loop backoff (any type did work → reset backoff).
   - Type enable-set = the boot module view: a type whose module is disabled must NEVER be claimed (test this).
   - Concurrency/lease semantics, retry/backoff-on-error, and heartbeat/lease renewal must be identical per job to today —
     read each worker's existing behaviour before folding it; where two workers differ (e.g. lease ttl), keep per-type parameters.
   - Do NOT fold in the two advisory-lock cleanup workers (identityProviderTestAttemptCleanup / platformInstanceRegistryCleanup),
     brandingAssetCleanup, sharedOAuthKeepalive, networkProxyEngineSupervisor, gatewayService, readiness workers. No LISTEN/NOTIFY.
2. `workersBootstrap.ts`: replace the six entries by one `platformJobsDispatcher` entry that receives the enabled type set (derived from
   `getBootModules()` + `MODULE_BY_WORKER_NAME`/`PLATFORM_MODULES[*].workers` — the module→worker names mapping already exists in
   `packages/const/src/platform/modules.ts`; do NOT rename worker names there, the module page lists them; if you must keep the six
   names as "virtual" workers for the module page, keep them in the registry with `start` delegating to the dispatcher). Keep the
   `[modules] worker … skipped` log line semantics for disabled modules (V1 checked it).
3. Tests: `apps/server/src/enterprise/jobs/*.test.ts` (existing must stay green, adapt only if an internal export moved),
   `auditWorkers.flagOff.test.ts`, new dispatcher tests (batch claim mixed types, disabled type never claimed, per-type error isolation:
   one handler throwing must not stop others, backoff resets on any work), model test for the batch claim in
   `packages/database` (`cd REPO/packages/database && bunx vitest run <file>`, PGlite).
4. Measurement in the report: count of DB round-trips per idle minute before (6 loops at 2–5s→ backoff 60s) vs after (1 loop),
   computed from intervals; the commander re-measures xact/s on the real container.

## Do — P6 (server half)
5. Merge the two 30s heartbeats into one write per tick: let `heartbeatRuntime.ts` remain the single ticker and have the IdP registry
   piggy-back (call its upsert from the same tick, or make the IdP registry heartbeat a listener of the platform-instance heartbeat)
   — whichever keeps both tables' semantics (rows/columns/`last_seen`) unchanged. Keep the phase-1 "edge predicate" in heartbeatRuntime.
   If the two writes target different tables and cannot be one statement, one tick with two statements is acceptable (goal: one timer,
   one transaction). Tests for both files must stay green.

Report → REPO/audit/slim-2026-08-17/phase2/reports/G2.md (≤120 lines): design as built, files, per-type parameters table, tests
run + results, expected idle round-trips/min before/after, anything the commander must do (e.g. docs paragraph).
