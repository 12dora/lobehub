# Enterprise module template

Copy this checklist when starting module **Mxx**.

## 1. Identity

- Module id: `M__`
- Wave: `W__`
- Feature Flags (all default **off**):
  - `ENABLE_…`
- Error code prefixes used: `PLATFORM_` / `ADMIN_` / `MANAGED_`

## 2. Directory placement

| Layer       | Path                                                                 |
| ----------- | -------------------------------------------------------------------- |
| Types       | `packages/types/src/platform/` (or module subfolder)                 |
| Constants   | `packages/const/src/platform/`                                       |
| Server      | `apps/server/src/enterprise/{routers,services,repositories,guards}/` |
| Client      | `src/enterprise/client/{routes,features,providers,services}/`        |
| DB (if any) | `packages/database/src/schemas/platform/` — **M01+ only**            |

Register UI routes/menus via `enterpriseModuleRegistry` — do not patch desktop router configs directly.

## 3. Upstream mounts

If you must edit an upstream file:

1. Confirm it is on `docs/enterprise-patches/patch-ledger.md`.
2. Keep the change to a single import + registration line.
3. Append a row to `docs/redevelopment/list/07_上游直接修改点台账.md`.
4. If touching `desktopRouter.config.tsx`, sync `desktopRouter.config.desktop.tsx`.

## 4. API / security

- [ ] tRPC procedures listed in `docs/redevelopment/list/02_tRPC接口清单.md`
- [ ] Permissions in matrix / `PLATFORM_PERMISSIONS`
- [ ] Capability snapshots never return roles, secrets, or internal config values
- [ ] Mutations use `reason` / `expectedRevision` when applicable
- [ ] Audit events planned (M01+)

## 5. Tests

- [ ] Flag-off regression (behavior matches upstream when disabled)
- [ ] Unit tests for services / parsers
- [ ] Router tests with `createCallerFactory`
- [ ] No secrets/tokens in fixtures or snapshots

## 6. i18n

- Add keys only under `packages/locales/src/default/*`
- Mirror `locales/en-US/` + hand-translate `locales/zh-CN/`
- Do **not** run `bun run i18n` in module PRs

## 7. Done criteria

- [ ] `bun run check` green on changed files
- [ ] Path boundary script green: `bun run enterprise:check-paths`
- [ ] Flags remain default off
- [ ] Patch ledger updated
