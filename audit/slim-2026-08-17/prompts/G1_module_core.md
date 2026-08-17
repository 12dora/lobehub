# G1 — Module core (backend): settings storage, effective resolution, guards, admin.modules API, capabilities

Read ../prompts/COMMON_RULES.md first (ownership: you are **G1**). Then read explore/E4_admin_setup.md §B6/B7/C1–C5/D
and E2_modules.md §C1/C5. Work only in /Users/konata/code/AIHub-worktrees/slim.

## Deliverables (in order; each with tests)
1. **Env parsing tests** for `packages/const/src/platform/modules.ts` (`modules.test.ts`): presets, `LOBE_MODULES_DISABLED`
   (spaces/commas/unknown ids), legacy `ENABLE_PLATFORM_*=0` mapping, `computeEffectiveModules` (missing row = all on;
   env wins over db `true`), `matchPreset`, lookup maps have no duplicate keys, every `workers` name is unique.
   Verify the router-key lists against the real routers (`apps/server/src/routers/lambda/index.ts` etc. and
   `apps/server/src/enterprise/routers/admin.ts`) and correct them in place (keep ids/tiers/kinds unchanged).
2. **DB single-row table** `platform_module_settings` (`id text PK CHECK (id='global')`, `modules jsonb NOT NULL DEFAULT '{}'`,
   `setup_completed_at timestamptz NULL`, `revision integer NOT NULL DEFAULT 1`, `updated_by text NULL`, `created_at/updated_at`).
   Template: `packages/database/src/schemas/platform/authSettings.ts` + its model. Model: `get()`, `upsertWithCas({modules, setupCompletedAt, expectedRevision, updatedBy})`
   returning the row or throwing a typed CAS conflict. Hand-written migration `packages/database/migrations/0020_platform_module_settings.sql`
   (idempotent) + `_journal.json` entry (idx 20, when 1787500000000, tag `0020_platform_module_settings`) + `meta/0020_snapshot.json`
   (copy 0019 snapshot and add the table). PGlite model test.
3. **Service** `apps/server/src/enterprise/services/moduleSettings/` — replace the stub internals, keep the exported contract:
   `getModuleSettingsSnapshot()` = env layer (`resolveModulesFromEnv(process.env, parseEnterpriseFeatureFlags())`) + DB row via
   `DomainConfigCache` (TTL 30s, template `services/infraSettings/snapshot.ts` incl. LKG + fail-open to env-only on DB error) +
   cross-instance invalidation (`publishPlatformConfigInvalidation`-style scope `modules`, see `services/platformConfigInvalidation.ts`);
   `updateModuleSettings({modules, expectedRevision, setupCompleted, actorUserId})` (CAS, invalidate, returns snapshot);
   `initBootModules()` awaited once (G2 calls it from instrumentation); `getPendingRestartModules()`. Also export
   `assertModuleEnabled(id)` (throws the enterprise error) and `moduleDisabledError(id)` for guards. Tests with the DB mocked
   (see how infraSettings snapshot tests mock) — cover: no row, row partial, env-forced-off wins, cache invalidation, boot freeze.
4. **Error code**: `PLATFORM_MODULE_DISABLED` in `packages/const/src/platform/errorCodes.ts` (+ its test), mapped to tRPC
   `FORBIDDEN` in `apps/server/src/enterprise/guards/enterpriseErrors.ts` with `data: { moduleId }`.
5. **Guards**:
   - `apps/server/src/enterprise/guards/platformPermission.ts`: after the existing `ADMIN_FEATURE_DISABLED` check (~:195-200),
     resolve `MODULE_BY_ADMIN_ROUTER_KEY[path.split('.')[1] ?? path.split('.')[0]]` (path is like `admin.audit.list` — verify the
     exact shape the middleware sees) and throw `PLATFORM_MODULE_DISABLED` when `!(await isModuleEnabled(moduleId))`.
     Also add a **request-scope cache** for `loadPlatformAuthContext` (E5 B4: admin overview runs the same 4-table RBAC join 10× per
     batch): memoize per `ctx` (WeakMap keyed by ctx object or a symbol on ctx) so one HTTP request = one join. Test both.
   - Fork user-facing sub-routers under `platform.*` (`platformAgents`, `platformSkills`, task templates procedures in `platform.ts`)
     get the same check via a small `withModule('managedAgents')` middleware helper (put helper in `guards/moduleGuard.ts`).
   - `apps/server/src/enterprise/routers/platform.ts`: DELETE the 14 top-level side-effect calls (lines ~51-81) and their now-unused
     imports — G2 re-homes them in `bootstrap/workersBootstrap.ts` (do not create that file). Keep `warnIfPlatformMasterKeyMissing` call
     out too (G2 moves it). Also `apps/server/src/enterprise/routers/admin.ts`: delete the 3 readiness calls at ~:48-50 (G2 re-homes)
     and mount `modules: adminModulesRouter`.
6. **admin.modules router** `apps/server/src/enterprise/routers/admin/modules.ts` + `contracts/adminModules.ts` (zod in/out):
   `get` (SYSTEM_READ), `update` (SYSTEM_OPERATE; audit log entry `admin.modules.update` with before/after diff; use existing
   reauth wrapper only if turning OFF `audit` or `moderation` — check how `system.ts` marks dangerous actions and mirror it),
   `requestRestart` (SYSTEM_OPERATE; reuse `services/identityProvider/restartController.ts` — generalize its capability check
   only if needed, keep old exports). Response shape per COMMON_RULES. Register all three in BOTH policy registries
   (`security/policy/adminProcedureAuthorization/entries.platform.ts`, `adminMutationRegistry/entries.platform.ts`) and bump the
   parity test counts (read the tests to see current numbers on this branch; +1 query, +2 mutations). Add optional `module?`
   metadata to registry entries only if trivial; otherwise skip.
7. **Capabilities + types**: `packages/types/src/platform/capabilities.ts` add `modules: PlatformModuleStateMap` (and to
   `DISABLED_PLATFORM_CAPABILITIES` = all true? — NO: disabled snapshot must be safe; use ALL_MODULES_ENABLED so nothing hides
   accidentally); fill it in `services/platformCapabilities.ts`. `packages/types/src/serverConfig.ts`
   `EnterprisePublicServerConfig.modules?: Record<string, boolean>` (G4 fills it in globalConfig — do NOT edit globalConfig/index.ts).
8. Docs: append a short "Module settings storage & API" section to `docs/enterprise/modules.md` **only if the file exists** (G5 creates
   it; else put your notes in your report and the commander stitches).

## Verification
`bun run check --lint --test <your files>`; `cd packages/database && bunx vitest run src/models/platform/moduleSettings.test.ts`;
run the registry parity tests and `apps/server/src/enterprise/guards/*.test.ts`. Report to ../reports/G1.md.
