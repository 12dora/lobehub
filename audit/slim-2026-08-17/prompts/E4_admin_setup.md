# E4 — Admin panel degradation & first-run setup wizard seams

Read EXPLORE_RULES.md (same directory) first. Write the report to `../explore/E4_admin_setup.md`.

Task: find how the admin console (and the user-facing app) should learn "module X is disabled", how it
should degrade, and where a first-run graphical setup wizard could live with minimal footprint.

## Part 1 — capability plumbing today
1. Trace how the client learns server-side capabilities today: `platform.getCapabilities` (fork),
   `globalConfig` / `getServerConfig` / `__SERVER_CONFIG__` (upstream), `featureFlags` state, the
   enterprise `ENABLE_*` flags → which store slices / selectors, and how the admin nav
   (`src/features/Admin*` nav builder, `src/spa/router/*` admin route trees) decides what to show.
   file:line for the assembly points. Note that in vite dev the SPA lacks `window.__SERVER_CONFIG__`
   (known quirk).
2. Inventory of admin pages that depend on an optional module (from the candidate list in
   EXPLORE_RULES: knowledge base, moderation, network proxy, audit, managed skills/connectors/agents,
   stats, branding, IdP, shared OAuth, ChatGPT web, task templates, S3-backed things like audit export /
   branding assets, Redis-backed things). For each page: route, permission code, what breaks today if
   the backing router/job/service is absent (grep for how tRPC "procedure not found" / 404 surfaces in
   the UI; the existing "加载失败" patterns; `AdminPageTemplate` banner slot).
3. Existing UI primitives for a "module disabled" state: empty states, `AdminPageTemplate` banner,
   `Result`, capability guards, `withPlatformPermission`, route guards (`AdminGuard`?), 403 pages —
   file:line. Recommend ONE pattern: nav hides disabled modules + direct URL shows a "模块未启用 →
   如何启用(env / 向导)" page + tRPC calls fail with a typed error code (e.g. `MODULE_DISABLED`) that
   the shared error mapper turns into a toast, not a crash. Say where each piece plugs in.
4. Server side: how admin procedures are registered/guarded (`withPlatformPermission`, security/policy
   registries under `apps/server/src/enterprise/security|policy`, the registry parity tests). If a
   module's router is not mounted, do the registry tests fail? Propose how the registries should treat
   "mounted-but-disabled" vs "not mounted".

## Part 2 — first-run setup wizard
5. Existing first-run / bootstrap flows: `BOOTSTRAP_SUPER_ADMIN_*` (startupBootstrap.ts), onboarding
   routes (`src/routes/onboarding`, `services/onboarding`), the admin "基础设施" infra card that stores
   S3 / mail overrides in `platform_infra_settings` (env-vs-DB `effective` pattern), the OIDC LKG
   snapshot, `platform_settings`-style tables. Which of these can carry "selected modules" persisted in
   DB with env as fallback/override, and how the server would read it at boot (before/after DB is up —
   chicken/egg: the module set decides which routers mount; note Next.js standalone builds a static
   route table, so decide what can be runtime-toggled vs boot-time-only).
6. Where a wizard would live: a gated route (e.g. `/setup`) shown when a `platform_setup` marker row is
   absent and the requester is the bootstrap super admin; steps (modules → infra checks → done);
   whether it can be an admin page instead (`/admin/system/modules`) with a "restart required" state
   like the existing `PLATFORM_OIDC_RESTART_MODE=supervisor` restart mechanism (cite how supervisor
   restart works and whether it can be reused for "apply module changes"). Recommend the cheapest
   viable design; list upstream files it would touch.
7. UX: consult `DESIGN.md` values and existing admin page conventions (AdminPageTemplate, DataTable,
   base-ui Switch) — describe the module page/wizard as a short spec (fields, states, copy keys),
   no code.

Section A: the recommended capability-plumbing pattern (one paragraph), the recommended wizard
placement (one paragraph), the list of upstream files that must change (with why), and the risks.
