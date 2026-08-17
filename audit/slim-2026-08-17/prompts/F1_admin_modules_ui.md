# F1 — Admin console: modules page (+ first-run guide), module-aware nav / route degradation, capability plumbing, polling knobs

Read ../prompts/COMMON_RULES.md first (ownership: you are **F1**). Then explore/E4_admin_setup.md §B1–B5, §C5–C8, §D
(this is your spec source — file:line for every seam), PLAN.md §3 (C1–C7) and §4b, and REPO/DESIGN.md (product values).
Follow AGENTS.md component priority (`@lobehub/ui/base-ui` first: Switch, Modal, Popover…), `createStaticStyles`, i18n rules.
Work only in /Users/konata/code/AIHub-worktrees/slim. Backend contract (G1, in parallel): see COMMON_RULES "Contracts" —
code against it; until G1 lands, mock the tRPC calls in your tests and keep the service typed to the contract shape.

## Deliverables
1. **Boot helper + selectors**: `src/enterprise/client/boot/getBootModules.ts` — reads `window.__SERVER_CONFIG__.config.enterprise.modules`;
   missing ⇒ `ALL_MODULES_ENABLED` (fail-open, vite dev has no server config). `src/store/serverConfig/selectors.ts` (upstream, +1
   selector `enterpriseModules`). A hook `useModuleEnabled(id)` (fork) that prefers the live `platform.getCapabilities().modules`
   (via the existing `useEnterprisePlatformData`) and falls back to boot modules.
2. **Nav + route degradation** (all fork): `nav/adminNavMeta.ts` — `AdminNavItem.moduleId?: PlatformModuleId`; annotate the leaves
   (audit group → `audit`; content-moderation → `moderation`; network-proxy tab → `networkProxy`; agents → `managedAgents`; skills →
   `managedSkills`; connectors → `managedConnectors`; branding → `branding`; identity providers → `databaseIdp`; stats →
   `platformStats`; task templates → `taskTemplates`; settings policy → `settingsPolicy`; AI providers/models/managed resources →
   `managedAi`; users/system/auth = core, no id). `filterAdminNavByPermissions(nav, perms, disabledModules = new Set())` hides items
   whose module is off (both in AdminSideNav and `GroupIndexRedirect`); `gates/AdminPermissionOutlet.tsx` — when the matched catalog
   item's module is off render `AdminModuleDisabledSurface` (new, in `pages/AdminStateSurfaces.tsx`, modeled on
   `AdminFeatureOffSurface`): title「模块未启用」, one line what it is, and a "how to enable" line: if disabled by env → show the exact
   variable (`envDisabledBy`), else a button/link to `/admin/system/modules`. Never 404. `SystemGeneralPage` tab gating: reuse the
   existing `canRead` pattern for the network-proxy tab (`canRead && moduleEnabled`) and never leave the admin on a hidden tab.
3. **Error code → toast**: `errors/mapEnterpriseError.ts` add `PLATFORM_MODULE_DISABLED → action 'none'` + locale
   `enterprise.error.PLATFORM_MODULE_DISABLED` (both languages).
4. **Modules page** `/admin/system/modules` (nav item under `system`, `SYSTEM_READ` to view / `SYSTEM_OPERATE` to change; add to
   `adminPageCatalog.tsx` as `lazy()`; feature folder `src/enterprise/client/features/admin/modules/**`; service
   `services/adminModules.ts` wrapping `admin.modules.get/update/requestRestart` with SWR via `@/libs/swr` scoped mutate).
   Layout (DESIGN.md: certainty, layered not split):
   - Header (AdminPageTemplate): title「模块」, description「关闭用不到的模块可以降低内存与后台任务开销。大部分改动保存后刷新页面即可生效；标有"需重启"的模块要重启服务才能释放资源。」
   - **Preset row**: three preset cards/segments「小机器 / 标准 / 完整」+ a「自定义」state that lights up whenever the current
     selection matches none (`matchPreset(effective)`); clicking a preset sets the local draft to that preset (does not save).
   - **Summary bar** (live, from the local draft): 预计常驻内存（sum of `cost.idleRssMb`, show「≈ N MB」or「未测量」when null）,
     后台任务数（sum `backgroundJobs`）, 每条消息附加处理（count of `loadKind === 'perMessage'` + `perFetch`）, 需要的配套（union of
     `externalDeps` → 图标/文字：对象存储 / Redis / 搜索引擎 / 外部服务）, and「需重启才生效」count. Compare against the three presets
     in a tooltip or a small table (「比标准档少 X MB / 少 N 个后台任务」).
   - **Module list** grouped「企业功能」/「上游功能」: each row = base-ui `Switch` + name + one-line description + tags:
     `kind === 'restart'` →「需重启」; `cost.subprocess` →「子进程」; `cost.loadSensitive` →「负载敏感」(red); `cost.loadKind` label
     (「每条消息」「每次请求」「每次出站」「使用时」）; `cost.backgroundJobs > 0` →「N 个后台任务」; `externalDeps` chips; a
     `StatusBadge`：运行中 / 已停用 / 待重启（in `pendingRestart`）/ 由环境变量控制（`envDisabledBy[id]` set → Switch disabled + tooltip
     with the variable name; reuse `src/features/PlatformSettingSourceBadge/`). `dependsOn` unmet → warning tag. Core modules are
     shown in a collapsed「核心模块（不可关闭）」footer list, disabled Switch + tooltip.
   - **Save**: sticky footer「保存」/「放弃」when draft ≠ effective; turning OFF `audit` or `moderation` → `DangerConfirm`
     (「已产生的记录不会删除，只是停止采集与查询入口」); save via `runAdminMutation` with `expectedRevision` (CAS conflict → reload +
     toast). Success toast says what changed (「已停用 3 个模块，其中 2 个需重启后释放资源」), not "成功".
   - **Restart banner** when `pendingRestart.length > 0`: text + 「立即重启」(calls `requestRestart`, then poll `get` until the
     instance comes back; reuse the three-state pattern of `identityProviderRestart.ts`); when `restart.supported === false` the
     button is replaced by「请在容器编排中重启服务」+ the env hint.
   - Four states: loading = skeleton; error = AdminPageTemplate banner + retry; empty n/a.
5. **First-run guide**: when `snapshot.setupCompletedAt === null` show a guide card at the top of the /admin overview page
   (「完成部署配置：① 选择模块 → ② 检查基础设施（链接到系统状态页探针）→ ③ 完成」, CTA → `/admin/system/modules?wizard=1`); with
   `?wizard=1` the modules page shows a 3-step stepper header (step 1 = this page; step 2 = a compact infra check that reuses the
   system status probes via existing hooks, read-only; step 3 = 完成 → `update({ setupCompleted: true })` then card disappears).
   Same component serves wizard and daily settings (DESIGN.md: layered, not split). Dismiss link「稍后再说」just hides for the session.
6. **Polling knobs** (fork): centralize the admin poll intervals in one constants file (`features/admin/shared/pollIntervals.ts`):
   getPublicSnapshot 30s / getCapabilities 60s / jobs 3s / audit live 4s / networkProxy 15s / IdP 1.5–2s; make the network-proxy
   status poll additionally gated by page visibility AND `useModuleEnabled('networkProxy')`; allow override via
   `window.__SERVER_CONFIG__.clientEnv` only if such a channel already exists — otherwise just constants (document).
7. **i18n**: keys `admin:modules.*` (page, presets, summary, tags, statuses, per-module `items.<id>.title/desc`, guide, restart) in
   `packages/locales/src/default/admin.ts` + `locales/en-US/admin.json` + `locales/zh-CN/admin.json` — TARGETED INSERTS ONLY (never
   rewrite/re-sort the files; keep `admin.parity.test.ts` green if it exists on this branch; check `bun run check --test` on it).
   Reuse the dead `system.flags.*` keys only if they fit; otherwise leave them.
8. Tests: vitest + RTL for the page states (env-controlled row disabled, custom badge, summary numbers, danger confirm on audit off,
   pending-restart banner, wizard stepper), nav filter, permission outlet degradation, error mapper. Playwright is NOT required.

Report ../reports/F1.md incl. the copy keys added and any contract mismatch you assumed. Screenshots optional.
