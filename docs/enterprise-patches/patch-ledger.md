# Enterprise patch ledger (AIHub)

> Living list of **upstream** files that enterprise code is allowed to touch.
> Prefer new code under `src/enterprise/**` and `apps/server/src/enterprise/**`.
> Authoritative design table: `docs/redevelopment/list/07_上游直接修改点台账.md`.

## Stable mount points (M00)

| Upstream file                                    | Change                                            | Module  | PR     | Notes                                  |
| ------------------------------------------------ | ------------------------------------------------- | ------- | ------ | -------------------------------------- |
| `src/business/client/BusinessDesktopRoutes.tsx`  | Spread `EnterpriseDesktopRoutesWithoutMainLayout` | M00/M03 | PR-003 | Must stay empty when flags/modules off |
| `src/business/client/BusinessGlobalProvider.tsx` | Wrap `EnterprisePlatformProvider`                 | M00/M12 | PR-003 | Transparent defaults when flags off    |
| `apps/server/src/routers/lambda/index.ts`        | `platform: platformRouter`                        | M00     | PR-003 | Read-only; admin router later          |
| `apps/server/src/globalConfig/index.ts`          | `serverConfig.enterprise.enabled`                 | M00     | fix    | Mount #4; gates client platform.\*     |
| `packages/types/src/serverConfig.ts`             | `EnterprisePublicServerConfig` type               | M00     | fix    | `{ enabled: boolean }` only            |
| `package.json`                                   | `enterprise:check-paths` script                   | M00     | PR-004 | Path boundary CI entry                 |

## M02 applied

| Upstream file                                                          | Change                                                                 | Module | PR        | Notes                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ | --------- | ------------------------------------------------------------------- |
| `packages/const/src/rbac.ts`                                           | Platform scope ALL-only helper; extend SYSTEM\_DEFAULT\_ROLES          | M02    | PR-009    | Prefer new helpers; existing workspace scope unchanged              |
| `packages/database/src/models/rbac.ts`                                 | `hasGlobalPermission` / `replaceGlobalUserRoles` / super-admin helpers | M02    | PR-009    | New methods only; `updateUserRoles` marked deprecated for admin use |
| `packages/business-server/src/trpc-middlewares/rbacPermission.ts`      | Flag-aware stub keeping export shape                                   | M02    | PR-013    | Workspace no-op retained; platform uses enterprise guards           |
| `apps/server/src/routers/lambda/index.ts`                              | Mount `admin: adminRouter`                                             | M02    | PR-010+   | Alongside existing `platform` mount                                 |
| `packages/database/src/utils/idGenerator.ts`                           | `platformEasyauthGrantSnapshots` prefix                                | M02    | PR-013A   | Append-only namespace                                               |
| `src/app/(backend)/.well-known/easyauth-app.json/route.ts`             | HTTP EasyAuth descriptor                                               | M02    | PR-013A   | Imports only `@/const/platform/*` (no enterprise import markers)    |
| `packages/trpc/src/lambda/index.ts` + `middleware/enterpriseAccess.ts` | Global `authedProcedure` aihub.access gate                             | M02    | rework B3 | Flag-off no-op; allowlist getAccessStatus / getMyAccess             |
| `src/libs/better-auth/define-config.ts`                                | session.create → EasyAuth login sync                                   | M02    | rework B3 | Dynamic import of `@/database/.../easyauthLoginSync` only           |

## M05 applied

| Upstream file                                             | Change                                                                               | Module | PR         | Notes                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ | ---------- | ------------------------------------------------------------------- |
| `apps/server/src/routers/lambda/user.ts`                  | getEffectiveSettings / patch/reset + updateSettings adapter + getUserState effective | M05    | PR-024–025 | Flag OFF preserves legacy; keyVaults never enter platform overrides |
| `packages/const/src/platform/errorCodes.ts`               | MANAGED\_SETTING\_\* path/value codes                                                | M05    | PR-022     | Fail-closed registry errors                                         |
| `packages/types/src/platform/settings.ts`                 | Settings policy types                                                                | M05    | PR-022     | Mode/visibility split                                               |
| `packages/locales` + `locales/{en-US,zh-CN}`              | Admin settings policy + user source badge copy                                       | M05    | PR-026     | Hand-authored EN/ZH only                                            |
| `scripts/enterprise/pathBoundaries.ts`                    | Allowlist user router + PlatformSettingSourceBadge meta hook                         | M05    | PR-026     | Stable M05 mount points                                             |
| `src/routes/(main)/settings/memory/features/Memory.tsx`   | Wire PlatformSettingSourceBadge for memory.enabled / effort                          | M05    | PR-026     | Hidden paths unmount; locked disables control                       |
| `src/routes/(main)/settings/about/features/Analytics.tsx` | Wire PlatformSettingSourceBadge for general.telemetry                                | M05    | PR-026     | Same pattern                                                        |
| `src/features/PlatformSettingSourceBadge/**`              | Reusable source / managed control badge                                              | M05    | PR-026     | Presentation only; server enforces                                  |
| `packages/database` migration 0120 + settings models      | visibility column, settings bundle pointer, override revisions                       | M05    | PR-023     | Idempotent; mode separated from visibility                          |

## M06 applied

| Upstream file / area                                                                                                                        | Change                                              | Module | PR         | Notes                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------ | ---------- | ------------------------------------------------------------------------------------ |
| `apps/server/src/routers/lambda/{aiProvider,aiModel,agentSkills,connector,agent,agentGroup,composio,home,oauthDeviceFlow,agentDocument}.ts` | Managed Guard and narrow personal-use exceptions    | M06    | PR-028–030 | 99 mutation registry; flag-off no-op; Composio requires local and remote owner proof |
| `apps/server/src/services/agentDocumentVfs/{index,path}.ts`                                                                                 | Shared canonical VFS path normalizer                | M06    | PR-030     | Skill source/target and ambiguous paths fail closed                                  |
| `src/routes/(main)/settings/**`, `src/routes/(main)/agent/**`, `src/routes/(main)/home/**`                                                  | Close managed definition/configuration entry points | M06    | PR-029–030 | Retain runtime use, conversations, Tool permissions and personal OAuth               |
| `src/store/tool/slices/composioStore/**`                                                                                                    | Narrow managed Composio OAuth contract              | M06    | PR-030     | No client Tool snapshot or arbitrary remote account id                               |
| `packages/{const,types,locales}/**` + `locales/{en-US,zh-CN}/**`                                                                            | Managed types, error codes, role grant and copy     | M06    | PR-027–030 | Hand-authored EN/ZH only                                                             |
| `scripts/enterprise/pathBoundaries.ts`                                                                                                      | Register M06 upstream mount points                  | M06    | PR-029–030 | Boundary tests cover the new allowlist                                               |

## M07 applied

| Upstream file / area                                                                                                                               | Change                                                                                            | Module | PR         | Notes                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ | ---------- | ---------------------------------------------------------------------------------- |
| `packages/database/src/schemas/platform/ai.ts`, `packages/database/src/models/platform/{aiCatalog,redact,revision,index}.ts`                       | AI Catalog, immutable Secret history, connection-test state, narrow Revision/Redaction extensions | M07    | PR-031–034 | Secret-free Revision/Audit and resourceType isolation                              |
| `packages/database/src/repositories/platformAiCatalog/**`, `packages/database/src/utils/idGenerator.ts`                                            | Catalog repository and ID namespace                                                               | M07    | PR-031–034 | Cursor, uniqueness and resourceType collision regression                           |
| `packages/database/migrations/0121*`, `packages/database/migrations/meta/**`, `docs/development/database-schema.dbml`                              | M07 migration, snapshot and DBML                                                                  | M07    | PR-031–034 | Journal/snapshot 122/122                                                           |
| `apps/server/src/globalConfig/index.ts` + `apps/server/src/modules/ModelRuntime/{index,platformAiRuntimeBridge}.ts`                                | Register Published execution resolver and model preflight bridge                                  | M07    | PR-034–036 | Flag-off no-op; builtin/custom runtime normalization; no public Secret             |
| `packages/model-runtime/src/core/ModelRuntime.ts`                                                                                                  | TTS/ASR preflight hooks                                                                           | M07    | PR-036     | Existing behavior and signatures remain compatible when hooks are absent           |
| `apps/server/src/routers/lambda/aiProvider.ts`, `src/app/(backend)/webapi/models/[provider]/{route,pull/route}.ts`                                 | Secret-free runtime state and managed model discovery/pull guard                                  | M07    | PR-034–036 | Published-only; fail closed before Secret/SDK initialization; bounded shadow state |
| `apps/server/src/services/memory/userMemory/{extract,persona/service}.ts`, `apps/server/src/services/toolExecution/serverRuntimes/agentBuilder.ts` | Route system workloads through the same Published Catalog and preflight                           | M07    | PR-036     | Unpublished or wrong-type models do not decrypt Secret or initialize SDK           |
| `src/store/aiInfra/slices/aiProvider/action.ts`                                                                                                    | Build picker groups from one Published runtime state                                              | M07    | PR-035–036 | No second client-side platform Catalog merge                                       |
| `packages/const/src/platform/errorCodes.ts`, `packages/locales`, `locales/{en-US,zh-CN}`                                                           | Stable managed-AI errors and admin copy                                                           | M07    | PR-031–036 | Hand-authored EN/ZH only                                                           |

## Planned (do not edit until owning module)

| Upstream file                  | Change | Module            | Notes |
| ------------------------------ | ------ | ----------------- | ----- |
| Better Auth / OIDC config      | M11    | Adapter + LKG     |       |
| Branding metadata / auth shell | M12    | Provider/fallback |       |

## M12 desktop packaging applied

| Upstream file / area                                                                                              | Change                                                                                | Module | PR     | Notes                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop/{electron-builder.mjs,electron.vite.config.ts}` + `src/main/core/infrastructure/ProtocolManager.ts` | Explicit AIHub product/AppId/icon/update profile; disable LobeHub scheme registration | M12    | PR-063 | User-visible metadata is AIHub-only; internal package/protocol identifiers remain unchanged                                          |
| `scripts/electronWorkflow/setDesktopVersion.ts`                                                                   | Brand-aware package metadata selection                                                | M12    | PR-063 | AIHub is stable-only; homepage and Linux maintainer are protected release inputs                                                     |
| `.github/actions/desktop-publish-s3/action.yml`                                                                   | Optional artifact brand/namespace plus schema-validated manifest rewriting            | M12    | PR-063 | Existing callers retain LobeHub defaults; AIHub publishes only below `aihub/stable`                                                  |
| `.github/workflows/release-desktop-aihub.yml` + desktop branding helper scripts                                   | Main-only protected build/sign/publish flow with immutable private brand assets       | M12    | PR-063 | Environment branch policy must allow only `main`; asset token is contents-read-only and checkout is pinned to an approved commit SHA |

## M04 applied

| Upstream file                                                                | Change                                                       | Module | PR         | Notes                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ------ | ---------- | ------------------------------------------------------------------------- |
| `packages/database/src/schemas/user.ts`                                      | Auth invalidation epoch + retained-session exception id      | M04    | PR-018–021 | Nullable expand migration 0119; disabled mode remains upstream-compatible |
| `packages/database/src/models/rbac.ts`                                       | Harden global-role replacement / last-super transaction      | M04    | PR-021     | Workspace roles are untouched and regression-tested                       |
| `packages/trpc/src/lambda/context.ts`                                        | Live ban/session-epoch validation and trusted auth metadata  | M04    | PR-020     | Retained current session is validated against Better Auth on every check  |
| `src/app/(backend)/api/auth/[...all]/route.ts`                               | Reject banned or invalidated sessions at auth boundary       | M04    | PR-020     | Feature-flagged; focused route tests                                      |
| `src/features/Auth/SignIn/useSignIn.ts`                                      | Reauth-only OIDC `prompt=login,max_age=0`                    | M04    | PR-020     | Normal sign-in remains unchanged                                          |
| `src/libs/better-auth/sso/index.ts`                                          | Forward reauth authorization parameters to Authentik/generic | M04    | PR-020     | Server-trusted auth method; no client self-assertion                      |
| `src/libs/oidc-provider/access-control.ts`                                   | Enforce auth time and platform session invalidation          | M04    | PR-020     | Credential issue time is distinct from authenticated-at                   |
| `docs/development/database-schema.dbml`                                      | Document the two M04 users columns                           | M04    | PR-018     | Mirrors migration 0119                                                    |
| `packages/locales/src/default/admin.ts` + `locales/{en-US,zh-CN}/admin.json` | Admin users / reauth copy                                    | M04    | PR-019–021 | Hand-authored EN/ZH preview; full i18n generation deferred                |

## M03 applied

| Upstream file                                                             | Change                                                | Module | PR     | Notes                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------- | ------ | ------ | ------------------------------------------- |
| `src/business/client/BusinessDesktopRoutes.tsx`                           | Spreads boot-gated enterprise routes                  | M03    | PR-014 | Empty when `enterprise.platformAdmin` false |
| `src/business/client/BusinessMobileRoutes.tsx`                            | Boot-gated `/admin` unsupported surface               | M03    | PR-014 | Empty when flag off                         |
| `apps/server/src/globalConfig/index.ts`                                   | `enterprise.platformAdmin` boolean                    | M03    | PR-014 | Feature existence only                      |
| `packages/types/src/serverConfig.ts`                                      | `platformAdmin?: boolean` on public enterprise config | M03    | PR-014 | No roles/permissions                        |
| `src/routes/(main)/settings/stats/features/components/StatsFormGroup.tsx` | Compatibility adapter → `@/components/SectionGroup`   | M03    | PR-017 | Settings callers unchanged                  |
| `scripts/enterprise/pathBoundaries.ts`                                    | Allow mobile business mount                           | M03    | PR-014 | Mirror desktop mount point                  |

## M13 security hardening applied (W8)

| Upstream file / area                                                                                           | Change                                                                | Module | Batch | Notes                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ | ----- | ------------------------------------------------------------------------------------------------- |
| `src/app/(backend)/api/auth/[...all]/route.ts`                                                                 | Observe terminal database-OIDC callback failures at the auth boundary | M13/14 | W8    | Status/category only; request body, token, callback code and raw error are never recorded         |
| `src/libs/better-auth/sso/platformIdentityProvider*.ts` + `src/libs/better-auth/utils/config.ts`               | Conditional secret reauth plus provider-bound login observations      | M13/14 | W8    | Cross-provider callbacks fail closed; state/nonce/token and upstream response bodies stay private |
| `apps/server/src/enterprise/security/**` + `apps/server/src/enterprise/services/secretRewrap/**`               | Vault key provider, secret rotation/rewrap and centralized policy     | M13    | W8    | New enterprise-owned implementation; fail closed and audit only stable redacted categories        |
| `packages/database/src/{schemas,models,repositories}/platform/**` + `packages/database/migrations/013{2,3,4}*` | Rotation state, single-active rewrap jobs and failure index           | M13    | W8    | Expand-only migrations; real PostgreSQL concurrency and replay gates                              |

## M14 consistency and observability applied (W8)

| Upstream file / area                                                                                     | Change                                                               | Module | Batch | Notes                                                                                      |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------ | ----- | ------------------------------------------------------------------------------------------ |
| `src/instrumentation.ts`                                                                                 | Start persistent instance heartbeat and operational metrics runtime  | M14    | W8    | Narrow dynamic imports; server runtime only; existing instrumentation startup remains      |
| `src/libs/redis/{manager,redis}*.ts`                                                                     | Bounded Redis initialization, cleanup and secret-free error handling | M14    | W8    | Source and sibling regressions cover failed-instance cleanup; only error class is logged   |
| `packages/observability-otel/package.json`                                                               | Export the enterprise-platform observability module                  | M14    | W8    | Additive package export; existing module exports remain unchanged                          |
| `packages/database/src/{schemas,models,repositories}/platform/**` + `packages/database/migrations/0135*` | Instance revision heartbeats and convergence projections             | M14    | W8    | Enterprise namespace; migration replay and multi-connection tests                          |
| `packages/locales/src/default/admin.ts` + `locales/{en-US,zh-CN}/admin.json`                             | Admin System health/convergence/job-control copy                     | M14    | W8    | Hand-authored EN/ZH only; no runtime identifiers or secrets                                |
| `src/enterprise/client/{routes,nav,features/admin/system,services/adminSystem*}/**`                      | Mount the reviewed Admin System operations console                   | M14    | W8    | Enterprise-owned UI; authoritative active-job polling and explicit partial-availability UX |
| `.github/workflows/enterprise-failure-drills.yml` + `scripts/enterprise/failure-drills/**`               | Real PostgreSQL/Redis failure-drill evidence gate                    | M14/15 | W8    | Raw Vitest JSON is deleted; uploaded evidence is bounded, redacted and assertion-counted   |

## M15 upstream-sync foundation applied (W8)

| Upstream file / area                               | Change                                                           | Module | Batch | Notes                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------- | ------ | ----- | ----------------------------------------------------------------------------------------- |
| `AGENTS.md`                                        | Preserve Next.js 16 generated agent guidance                     | M15    | W8    | Generated by Next.js; committing it avoids recurring dirty-tree drift                     |
| `package.json`                                     | Add the exact Better Auth core dependency used by OIDC lifecycle | M14/15 | W8    | Version matches the Better Auth family; no sync/fetch/push command is added               |
| `scripts/enterprise/rebase-report.ts`              | Local-only rebase, hotspot and patch-drift report                | M15    | Q05-1 | Explicit refs only; no fetch/push/checkout; isolated temporary clone is always removed    |
| `docs/redevelopment/list/07_上游直接修改点台账.md` | Authoritative M13/M14/W8 direct-edit registry                    | M15    | Q05-1 | Report parser consumes path cells only; prose and private implementation content stay out |

## Rules

1. Any new upstream direct edit **must** add a row here and in `07_上游直接修改点台账.md`.
2. Prefer adapters / registries over editing core signatures.
3. On upstream rebase, record conflicts against this list.
4. Feature Flags stay **default off** until M15 enables them.

## M00 conflict isolation

Do **not** create/modify in M00 (owned by M01 parallel worktree):

- `packages/database/src/schemas/platform/**`
- `packages/database/src/models/platform/**`
- database migrations for platform tables
- `apps/server/src/enterprise/services/platformPublisher.ts`
- `apps/server/src/enterprise/services/platformAudit.ts`
