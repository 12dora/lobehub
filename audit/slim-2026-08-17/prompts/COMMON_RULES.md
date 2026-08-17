# COMMON RULES — "slim" batch (deployment slimming / optional modules), LobeHub Enhanced

You are one coding agent in a batch of ~8 running IN PARALLEL in the SAME git worktree. Read this whole
file, then your own brief. Deviating from the file-ownership rules breaks other agents' work.

## Repo / branch
- REPO = /Users/konata/code/AIHub-worktrees/slim  (branch `feat/slim-modules`, based on main d1fc9295d2).
  This is the ONLY tree you may touch. Never touch /Users/konata/code/AIHub.
- Read REPO/AGENTS.md first (tech stack, `bun run check`, i18n rules, base-ui component priority).
- Design context (read once, cite when useful): the exploration reports in
  audit/slim-2026-08-17/explore/
  (E1_runtime.md, E2_modules.md, E3_docker.md, E4_admin_setup.md, E5_request_path.md) and the plan
  ../PLAN.md. They contain measured numbers and exact file:line seams — trust them over guesses, but
  verify against the code before editing.
- The commander's contract files already exist and are the source of truth for ids / presets / semantics:
  - REPO/packages/const/src/platform/modules.ts  (module ids, tiers, kinds, cost shape, presets, pure resolvers)
  - REPO/apps/server/src/enterprise/services/moduleSettings/index.ts (service CONTRACT; env-only stub, G1 fills it)
  Do NOT rename ids/exports. Router-key lists inside modules.ts may be corrected in place (only by G1/G3, see ownership).

## Non-negotiable semantics (fixed with the product owner)
1. Every module defaults ON. An unconfigured deployment must behave exactly like today.
2. env can only DISABLE: `effective[id] = envDisabled ? false : (dbRow?.modules[id] ?? true)`. Missing DB row = all ON.
   `LOBE_MODULE_PRESET=minimal|standard|full` (default full) + `LOBE_MODULES_DISABLED=a,b`. Legacy
   `ENABLE_PLATFORM_*=0` also disables the mapped module (see `enterpriseFlag`).
3. tRPC routers are ALWAYS mounted. A disabled module answers `PLATFORM_MODULE_DISABLED` (tRPC code FORBIDDEN,
   `data.moduleId`), never NOT_FOUND. Never conditionally mount a router or change router shape by env.
4. Two views: hot (`getModuleSettingsSnapshot()/isModuleEnabled()`, 30s cache, cross-instance invalidation)
   for request-time gates + UI; boot (`initBootModules()/getBootModules()/isBootModuleEnabled()`, frozen per
   process) for workers / gateway / subprocess / eager imports. `kind:'restart'` modules → "pending restart" state.
5. Permissions are orthogonal: never revoke/seed RBAC because a module is off. `ENABLE_PLATFORM_ADMIN=0`
   behaviour must not change.
6. Upstream-merge friendliness: touching an upstream file (anything outside `apps/server/src/enterprise/**`,
   `src/enterprise/**`, `packages/const/src/platform/**`, `packages/types/src/platform/**`,
   `packages/database/src/{schemas,models}/platform/**`, `docker-compose/enhanced/**`, `docs/enterprise/**`) is
   allowed ONLY as: one-line guards, one-line replacements, a wrapper/memo around an existing function, or an
   `await import()` in place of a static import. Put logic in fork files and import it. Keep upstream diffs
   tiny and mechanical; never reformat / re-sort / restructure upstream files.
7. Fail-open on the client when `window.__SERVER_CONFIG__` is missing (vite dev): treat all modules as enabled.

## Contracts shared between agents (code against these; do not wait for each other)
```ts
// packages/const/src/platform/modules.ts (exists)
PlatformModuleId, PLATFORM_MODULE_IDS, PLATFORM_MODULES[id] = { adminRouterKeys, asyncRouterKeys, cost,
  dependsOn, enterpriseFlag?, featureFlagKeys, id, kind:'hot'|'restart', lambdaRouterKeys, origin, tier,
  toolsRouterKeys, workers }, PLATFORM_MODULE_PRESETS, modulesForPreset(), MODULE_BY_ADMIN_ROUTER_KEY,
  MODULE_BY_LAMBDA_ROUTER_KEY, MODULE_BY_ASYNC_ROUTER_KEY, MODULE_BY_TOOLS_ROUTER_KEY, MODULE_BY_WORKER_NAME,
  resolveModulesFromEnv(env, enterpriseFlags), computeEffectiveModules(envDisabled, db), matchPreset(),
  RESTART_MODULE_IDS, ALL_MODULES_ENABLED, PLATFORM_MODULE_PRESET_ENV, PLATFORM_MODULES_DISABLED_ENV

// apps/server/src/enterprise/services/moduleSettings/index.ts (exists as env-only stub; G1 replaces internals)
ModuleSettingsSnapshot { db, effective, envDisabled, envDisabledBy, preset, presetFromEnv, revision, setupCompletedAt }
getModuleSettingsSnapshot(): Promise<ModuleSettingsSnapshot>; isModuleEnabled(id): Promise<boolean>
initBootModules(): Promise<PlatformModuleStateMap>; getBootModules(): PlatformModuleStateMap; isBootModuleEnabled(id): boolean
getPendingRestartModules(): Promise<PlatformModuleId[]>; resetModuleSettingsForTest()

// error code (G1 adds): packages/const/src/platform/errorCodes.ts  PLATFORM_MODULE_DISABLED  → tRPC FORBIDDEN, data { moduleId }
// tRPC (G1 adds) admin.modules.*  (SYSTEM_READ for get, SYSTEM_OPERATE for mutations; registered in both policy registries)
//   admin.modules.get    → { snapshot: ModuleSettingsSnapshot; pendingRestart: PlatformModuleId[];
//                            restart: { supported: boolean; reason?: string }; instanceId: string }
//   admin.modules.update → input { modules: Partial<Record<PlatformModuleId, boolean>>; expectedRevision: number;
//                            setupCompleted?: boolean }  → same shape as get   (CAS; audit log; cross-instance invalidation)
//   admin.modules.requestRestart → input {} → { ok: true }  (self SIGTERM via existing restartController when supported)
// capabilities (G1 adds): PlatformCapabilities.modules: PlatformModuleStateMap  (platform.getCapabilities)
// server config (G4 adds field, G1 owns type): EnterprisePublicServerConfig.modules?: PlatformModuleStateMap
//   → window.__SERVER_CONFIG__.config.enterprise.modules
// client boot helper (F1 adds): src/enterprise/client/boot/getBootModules.ts → PlatformModuleStateMap (fail-open)
// worker registry (G2 adds): apps/server/src/enterprise/bootstrap/workersBootstrap.ts
//   WorkerSpec { name /* must equal an entry of PLATFORM_MODULES[*].workers or be core */; moduleId?; start(): void|Promise<void> }
//   startEnterpriseWorkers(): Promise<void>  (called from src/instrumentation.ts after initBootModules())
// i18n namespace `admin`, keys `modules.*` (F1 owns; server code must not add locale keys)
```

## Ownership (exclusive file sets — if you must touch a file owned by someone else, STOP and note it in your report)
- G1 module core (backend): packages/const/src/platform/{modules,errorCodes}.ts (+tests), packages/types/src/platform/capabilities.ts, packages/types/src/serverConfig.ts, packages/database/src/schemas/platform/moduleSettings.ts (+index), packages/database/src/models/platform/moduleSettings.ts (+index), packages/database/migrations/0020_platform_module_settings.sql + meta/_journal.json + meta/0020_snapshot.json, apps/server/src/enterprise/services/moduleSettings/**, apps/server/src/enterprise/guards/{platformPermission,enterpriseErrors}.ts, apps/server/src/enterprise/routers/{platform,admin}.ts, apps/server/src/enterprise/routers/admin/modules.ts (new) + contracts/adminModules.ts (new), apps/server/src/enterprise/security/policy/** (registries), apps/server/src/enterprise/services/platformCapabilities.ts, apps/server/src/enterprise/services/identityProvider/restartController.ts, apps/server/src/enterprise/routers/platform{Agents,Skills}.ts, admin/taskTemplates*.ts (guards only).
- G2 boot gates: apps/server/src/enterprise/bootstrap/workersBootstrap.ts (new), apps/server/src/enterprise/jobs/**, apps/server/src/enterprise/services/connectorCatalog/{runtimeAuditWorker,secretCleanupWorker,runtimeEffectiveStateBootstrap}.ts, apps/server/src/enterprise/services/networkProxy/engine/** (start predicate only), apps/server/src/enterprise/services/{aiCatalog/runtimeBridge.ts,skillCatalog/*readiness*,connectorCatalog/*readiness*}, apps/server/src/enterprise/services/platformInstance/heartbeatRuntime.ts (module-aware only, keep edge predicate), src/instrumentation.ts, apps/server/src/services/gateway/** + the gateway start route, src/server/agent-hono/**, src/app/(backend)/api/workflows/**, src/app/(backend)/api/v1/**, apps/server/src/modules/ModelRuntime/index.ts (lazy chatgptWeb transport only), apps/server/src/enterprise/services/chatgptWeb/transport/index.ts.
- G3 upstream routers + flags + eager imports: apps/server/src/routers/{lambda,async,tools,mobile}/index.ts, apps/server/src/enterprise/routers/moduleRouter.ts (new helper), apps/server/src/featureFlags/index.ts, and the specific upstream files that statically import sharp / @aws-sdk / xlsx / @xmldom / search providers / builtin-tools at boot (from the G0 spike report `../explore/G0_spike.md`; if absent, find them yourself), packages/builtin-tools/src/index.ts, apps/server/src/services/search/impls/index.ts.
- G4 hot-path algorithms: apps/server/src/globalConfig/** (memo + `enterprise.modules` field), packages/trpc/src/lambda/context.ts (assertUserActive TTL via a fork helper file you create under apps/server/src/enterprise/guards/userActiveCache.ts), src/business/client/model-bank/loadModels.ts + packages/model-bank/src/aiModels/index.ts (memo), apps/server/src/enterprise/services/branding/resolvePublicSnapshot.ts, apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts, apps/server/src/enterprise/services/aiCatalog/runtimeAdapter.ts, apps/server/src/enterprise/runtimeConfig/domainCache.ts, apps/server/src/enterprise/services/platformConfigInvalidation.ts, apps/server/src/enterprise/services/networkProxy/{snapshot.ts,egress/**}, apps/server/src/enterprise/services/contentModeration/** (runtime/moderationAwareRuntime.ts, decisionService.ts, regexWorker.ts, keywordMatcher.ts), apps/server/src/enterprise/services/settings/runtimeSettingsAdapter.ts, apps/server/src/services/aiAgent/index.ts (only the duplicate getUserSettings — minimal).
- G5 docker/deploy: Dockerfile, next.config.ts, src/libs/next/config/define-config.ts, docker-compose/enhanced/**, .env.example, scripts/serverLauncher/startServer.js, docs/enterprise/modules.md (deployment sections; leave a `<!-- G1/F1 sections -->` marker), README module section, packages/locales/**?? NO (F1 only).
- F1 admin front: src/enterprise/client/** (nav/adminNavMeta.ts, nav/adminPageCatalog.tsx, features/admin/gates/**, features/admin/pages/AdminStateSurfaces.tsx, features/admin/system/** (new modules page under features/admin/modules/**), providers/useEnterprisePlatformData.ts, errors/mapEnterpriseError.ts, boot/**, services/adminModules.ts (new), features/admin/networkProxy/hooks.ts + audit/shared/useCursorPagination.ts + system/hooks/useAdminSystem.ts + identityProviders/useIdentityProviders.ts (poll constants only)), packages/locales/src/default/admin.ts + locales/en-US/admin.json + locales/zh-CN/admin.json (targeted inserts ONLY — never rewrite/re-sort; parity test admin.parity.test.ts must stay green), src/store/serverConfig/selectors.ts (+1 selector), src/features/PlatformSettingSourceBadge/** (reuse).
- F2 client bundle: vite.config.ts (+ any vite/rolldown chunk config), the Shiki import site(s), i18n loader (src/utils/i18n/**, packages/locales/src/create.ts only if unavoidable), src/features/Conversation/Messages/Tasks/shared/{ProcessingState,InitializingState}.tsx, src/routes/(main)/memory/features/MemoryAnalysis/useTask.ts, src/features/EditLock/useEditLock.ts, src/libs/swr/index.ts, the ErrorContent / TagCloudCanvas lazy points, index.html preload of `ar` locale.
- Commander only: PLAN.md, packages/const/src/platform/modules.ts semantics, final docs stitching, commits.

## Working rules
- Do NOT commit, do NOT push, do NOT `git stash/checkout/reset`, do NOT run `git add`. Just leave your files modified. The commander commits per package.
- Tests: write/adjust vitest tests next to changed code. Run only targeted tests: `cd REPO && bun run check --test <files>` or `cd REPO/<pkg> && bunx vitest run --silent='passed-only' <file>`. NEVER run the full `bun run test`. Never run full `tsgo`/`tsc` (the commander runs it once at the end) — instead run `bun run check --lint <files>` on your files.
- packages/database tests: `cd REPO/packages/database && bunx vitest run <file>` (PGlite). Migration SQL must be idempotent (`IF NOT EXISTS`), hand-written (drizzle-kit generate is broken here); `_journal.json` entry idx 20, tag `0020_platform_module_settings`, when ≥ 1787500000000. Also add `meta/0020_snapshot.json` by copying 0019 and adding the table (or note if too heavy).
- Existing repo pitfalls: `import { mutate } from 'swr'` is a no-op in admin (use `@/libs/swr` scoped mutate); base-ui Select needs fixed width; `createModal` content captured once; `.ts` files can't hold react-hooks eslint disables (use .tsx); registry parity tests count admin procedures (currently 216 total / 101 queries / 115 mutations after the peer batch — on THIS branch base it may be 215/101/114: read the tests); tests/setup.ts sets ENABLE_* to '0' — module tests must set env explicitly.
- Copy for users: Chinese + English via i18n only (F1). Server error messages: English, terse.
- Report: when done, write `../reports/<YOUR_ID>.md` with: what changed (file list), how verified (commands + results), open questions / files you needed but didn't own, and anything the commander must do (e.g., counts to update). Keep it ≤120 lines. Your final message = path + 10-line summary.
