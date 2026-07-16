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

## Planned (do not edit until owning module)

| Upstream file                            | Change             | Module             | Notes                |
| ---------------------------------------- | ------------------ | ------------------ | -------------------- |
| `apps/server/src/routers/lambda/user.ts` | Effective settings | M05                | Via service wrappers |
| Managed guards on AI routers             | M06                | Unified middleware |                      |
| Better Auth / OIDC config                | M11                | Adapter + LKG      |                      |
| Branding metadata / auth shell           | M12                | Provider/fallback  |                      |

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
