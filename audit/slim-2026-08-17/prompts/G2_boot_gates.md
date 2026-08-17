# G2 — Boot-time gates: worker registry + idle backoff, GatewayService, webapi gates, wrappers by module

Read ../prompts/COMMON_RULES.md first (ownership: you are **G2**). Then read explore/E1_runtime.md §B3/B4/C1/C2/C3/D and
E2_modules.md §B2/C2/C3, E5_request_path.md §B9 rows 6-7. Work only in /Users/konata/code/AIHub-worktrees/slim.

Measured facts you are fixing: idle CPU of next-server is 100% the 11 enterprise workers (1.57% CPU + 2.35 DB xact/s
vs 0.075% + 0.2 without them); they start as top-level side effects of `apps/server/src/enterprise/routers/platform.ts:51-81`
(G1 deletes those lines; you re-home them). GatewayService (bots) auto-starts in `src/instrumentation.ts:52-68` with no flag
and costs 3.6s boot + the discord/telegram/slack graph.

## Deliverables
1. `apps/server/src/enterprise/bootstrap/workersBootstrap.ts` (new) — a registry:
   `WorkerSpec { name: string; moduleId?: PlatformModuleId; start: () => void | Promise<void> }` × all 14 former side effects +
   the 3 readiness registrations from `routers/admin.ts:48-50` + `warnIfPlatformMasterKeyMissing` (core, always) +
   `ensureConnectorRuntimeCapabilityStateBootstrapped` (core, process-once — see its SR-003 comment).
   Names MUST equal `PLATFORM_MODULES[*].workers` entries in `packages/const/src/platform/modules.ts` for module-owned workers
   (`auditExport`, `auditRetention`, `agentRollout`, `connectorRuntimeAudit`, `connectorSecretCleanup`, `sharedOAuthKeepalive`,
   `brandingAssetCleanup`, `identityProviderTestAttemptCleanup`, `platformInstanceRegistryCleanup`, `networkProxyEngineSupervisor`,
   `gatewayService`); `secretRewrap` is core but must only start when the platform key provider is Vault (read
   `security/secret` / key provider config; today it polls every 2s even without Vault — E1 D2 says keep default ON where Vault).
   `startEnterpriseWorkers()` : for each spec, skip when `spec.moduleId && !isBootModuleEnabled(spec.moduleId)`; log one line per
   skipped worker (`[modules] worker <name> skipped: module <id> disabled`); errors in one spec must not stop others (try/catch).
   Keep `isPersistentEnterpriseWorkerRuntime()` semantics. Add a test that (a) all module worker names exist in
   `MODULE_BY_WORKER_NAME`, (b) disabled module ⇒ start not called, (c) one failing start doesn't block the rest.
2. Fix flag mismatches while you are there: `platformInstanceRegistryCleanup` is guarded by `ENABLE_DATABASE_OIDC` (E2 says mismatch —
   decide the right guard: it belongs to databaseIdp module per modules.ts, so keep but via the registry); jobs that had **no** flag
   (secretRewrap / brandingAssetCleanup / sharedOAuthKeepalive / connectorRuntimeAudit) now get theirs via the registry.
3. **Idle backoff** in `apps/server/src/enterprise/jobs/persistentWorkerScheduler.ts`: let `run()` return `{ didWork: boolean } | void`;
   after N (=3) consecutive no-work runs, multiply the delay ×2 up to `maxIdleIntervalMs` (default 60_000, per-worker option), reset to
   `baseIntervalMs` immediately when work was done. Update the 6 high-frequency workers (agentRollout 2s / secretRewrap 2s /
   auditExport 3s / auditRetention 3s / connector×2 5s) to report `didWork` truthfully. Keep `.unref()`. Tests with fake timers.
   Optional if time permits: single dispatcher for the `platform_jobs`-table pollers (one poll, dispatch by job type) — only if
   the code is clearly shaped for it; otherwise write the design in your report.
4. `src/instrumentation.ts` (upstream, minimal): as the first `nodejs` step `await (await import('@/server/enterprise/services/moduleSettings')).initBootModules()`
   (try/catch, non-blocking like the others); then `await (await import('@/server/enterprise/bootstrap/workersBootstrap')).startEnterpriseWorkers()`
   after the existing bootstrap steps; and add `&& isBootModuleEnabled('bots')` to the GatewayService condition (import inside the
   `if` via the same dynamic import). Keep everything else byte-identical. Also `apps/server/src/services/gateway/**`: the
   `/api/agent/gateway/start` handler (find it) must early-return `{ ok:false, disabled:true }` with HTTP 200 when bots is off
   (startServer.js polls it up to 10× — G5 adds an env guard there; you make the handler cheap).
5. **webapi/Hono gates**: `src/server/agent-hono/index.ts` — one `app.use('*', moduleGate)` where `moduleGate` (fork file
   `apps/server/src/enterprise/guards/webapiModuleGate.ts`) maps path prefixes → module ids (bots/messenger/webhooks → `bots`,
   agentSignal paths → `agentSignal`, …; derive from the handler list) and answers 403 JSON `{ error: 'PLATFORM_MODULE_DISABLED', moduleId }`
   when disabled (hot check). `src/app/(backend)/api/workflows/[[...route]]/route.ts` (module `workflows`) and
   `api/v1/[[...route]]/route.ts` (which module? — openapi is core; only gate if it is clearly optional; else leave) get a 3-line early exit.
6. **Wrappers by module**: `apps/server/src/enterprise/services/aiCatalog/runtimeBridge.ts:~95` registers the content-moderation
   ModelRuntime wrapper unconditionally → register only when `isBootModuleEnabled('moderation')`; the network-proxy egress binding
   (`setEgressBinding` reached via `apps/server/src/modules/ModelRuntime/index.ts:32` → `enterprise/services/chatgptWeb/transport`) →
   make the chatgptWeb transport import lazy (`await import()` inside the code path that needs it) and bind egress only when
   `isBootModuleEnabled('networkProxy')`. Also `services/networkProxy/engine/*` supervisor start predicate: skip when networkProxy off
   (through the registry). Do NOT touch `services/networkProxy/egress/**` or `snapshot.ts` (G4 owns them).
7. `heartbeatRuntime.ts`: keep the `NEXT_RUNTIME !== 'edge'` predicate (documented pitfall). No module gate (core).

## Verification
Targeted vitest for jobs/, bootstrap/, instrumentation.test.ts, gateway; `bun run check --lint <files>`. Report ../reports/G2.md
including the final worker table (name / module / interval / backoff max).
