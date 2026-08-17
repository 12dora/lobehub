# VERDICT: REWORK

## FINDINGS

1. **MAJOR** · `src/enterprise/client/hooks/useModuleEnabled.ts:29` · **[verified]** The boot fallback is effectively unreachable: `capabilities.modules` is always an object because both provider fallbacks use `DISABLED_PLATFORM_CAPABILITIES.modules = ALL_MODULES_ENABLED`. During loading, fetch failure, or a partial tree, boot-disabled modules therefore appear enabled. This exposes their navigation/routes until the live request succeeds. Fix by distinguishing unresolved capabilities or seeding the fallback capability map from `getBootModules()`; add pending-fetch and failed-fetch regression tests.

2. **MAJOR** · `src/enterprise/client/nav/adminNavMeta.ts:327` · **[verified]** `/admin/unified` remains module-blind. Its tabs only check RBAC, so disabling `settingsPolicy` or `managedAi` hides the legacy deep links but leaves the same functionality reachable through the visible unified page, where requests degrade to backend errors. Fix `UnifiedManagementPage` to gate both tabs by their modules and fall back from a newly hidden active tab; test both alternate paths.

3. **MAJOR** · `src/enterprise/client/features/admin/modules/ModulesPage.tsx:180` · **[verified]** Initial-load failure still renders an editable module list backed by `ALL_MODULES_ENABLED`. Users can change switches and press Save, but `commit()` silently returns because `data` is absent. Fix the `error && !data` branch to render only the error state and retry action; assert that no switches, presets, or Save control appear.

4. **MAJOR** · `src/enterprise/client/features/admin/modules/ModulesPage.tsx:130` · **[verified]** Every failed mutation is treated as a CAS conflict: the code revalidates and clears the draft after network errors, authorization failures, or cancelled reauthentication. This loses the operator’s unsaved selection. Fix by detecting `PLATFORM_REVISION_CONFLICT` and reloading only for that code; preserve the draft and allow retry for other failures.

5. **MAJOR** · `src/enterprise/client/features/admin/modules/ModulesPage.tsx:202` · **[verified]** Wizard completion calls `commit(current, true)` directly, bypassing `onSave` and its required `DangerConfirm`. Audit or moderation can therefore be disabled from wizard mode without the compliance warning. Route wizard completion through the same confirmation path and add a wizard-mode regression test.

6. **MAJOR** · `src/enterprise/client/features/admin/modules/ModuleSummaryBar.tsx:80` · **[verified]** The default table currently has `idleRssMb: null` for all 24 modules, yet the page displays `≥ 0 MB` and compares presets as zero-memory deltas. This is misleading on the page’s primary sizing metric and contradicts the required “Unmeasured” state. Render “Unmeasured” when no enabled module has a measurement, and suppress memory comparisons whose totals are incomplete.

7. **MAJOR** · `src/enterprise/client/features/admin/modules/ModuleWizard.tsx:120` · **[verified]** Infrastructure probe failures are ignored. With `statusSWR.error` and no data, step 2 renders “loading” forever and offers no retry, while still allowing progression. Handle error before the data/loading branch and provide a retry action.

8. **MINOR** · `src/enterprise/client/features/admin/modules/SetupGuideCard.tsx:62` · **[verified]** “Later” is component-local state, not session state. Navigating away and returning remounts the card, and exiting the wizard does not dismiss it. Store the dismissal in session storage or a session-scoped store shared by the card and wizard.

9. **MINOR** · `src/enterprise/client/features/admin/modules/ModuleRestartBanner.tsx:78` · **[verified]** Unsupported restart reasons such as `supervisor_not_configured` are rendered verbatim. These are internal enum tokens, despite translated reason keys already existing. Map the reason through i18n and include the applicable restart environment hint.

10. **MINOR** · `src/enterprise/client/features/admin/shared/pollIntervals.ts:17` · **[verified]** Polling is not fully centralized: the provider still owns independent `30_000` and `60_000` literals, while this table merely duplicates them and tests equality. Move the table to a shared layer the provider can import, then derive the provider exports from it.

## METRICS

- Files reviewed: **46** — 23 tracked modifications and 23 untracked files.
- Upstream files touched:
  - `src/store/serverConfig/selectors.ts` — **compliant**, one-line selector addition.
  - `packages/locales/src/default/admin.ts` — **compliant under F1’s explicit locale carve-out**, targeted additive keys only.
  - `locales/en-US/admin.json` — **compliant under the locale carve-out**, targeted additive keys only.
  - `locales/zh-CN/admin.json` — **compliant under the locale carve-out**, targeted additive keys only.
- Locale key and interpolation-placeholder parity across default, en-US, and zh-CN was verified.
- No migration files were in F1 scope.

## UNVERIFIED

- Vitest was not run, per the read-only review instruction.
- `tsgo --noEmit --incremental false` could not produce a clean project result because of the unrelated existing error at `src/components/mdx/Image.tsx:34`; no F1-specific diagnostic was emitted before failure.
- Browser rendering, focus behavior, restart convergence, and multi-instance polling behavior remain unverified.