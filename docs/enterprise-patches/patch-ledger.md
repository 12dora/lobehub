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

## Planned (do not edit until owning module)

| Upstream file                                                     | Change                 | Module             | Notes                 |
| ----------------------------------------------------------------- | ---------------------- | ------------------ | --------------------- |
| `packages/database/src/schemas/index.ts`                          | Export platform schema | M01                | Owned by M01 worktree |
| `packages/const/src/rbac.ts`                                      | Platform permissions   | M02                | High conflict risk    |
| `packages/database/src/models/rbac.ts`                            | Global query scope     | M02                | Prefer new methods    |
| `packages/business-server/src/trpc-middlewares/rbacPermission.ts` | Real platform RBAC     | M02                | Keep export shape     |
| `apps/server/src/routers/lambda/user.ts`                          | Effective settings     | M05                | Via service wrappers  |
| Managed guards on AI routers                                      | M06                    | Unified middleware |                       |
| Better Auth / OIDC config                                         | M11                    | Adapter + LKG      |                       |
| Branding metadata / auth shell                                    | M12                    | Provider/fallback  |                       |

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
