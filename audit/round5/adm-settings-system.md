# Round 5 Audit — adm-settings-system

## Scope

Audited all assigned paths:

- `src/enterprise/client/features/admin/{settings,generalSettings,branding,system,managedResources}`
- Assigned admin service files under `src/enterprise/client/services/`

The baseline diff contains **85 fork-owned files**: 48 production feature files, 30 test files, and 7 service files. Fork delta: **12,610 added LOC, 0 deleted LOC**. Every assigned file differs from baseline; no byte-identical upstream files were included.

Locale files were read for D4/D7 verification, and the unified-management tab owner was read only to verify an in-scope navigation interaction. Of the listed Round-4 remediation commits, `d84ca6758a` touched this scope and was treated as a prime suspect.

## Summary

| Dimension                                     | Findings | Highest severity |
| --------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                |        2 | MEDIUM           |
| D2 Test decay                                 |        1 | MEDIUM           |
| D3 Dead code and development debris           |        1 | LOW              |
| D4 Missing Simplified Chinese i18n coverage   |        1 | MEDIUM           |
| D5 Potential functional bugs                  |        3 | HIGH             |
| D6 Warnings and errors not surfaced via toast |        2 | MEDIUM           |
| D7 Overly technical UI strings                |        2 | LOW              |
| D8 Missing animations / motion                |        1 | LOW              |

## Findings

### adm-settings-system-D5-001 — Unified-management tab switches bypass unsaved-change guards and can discard the managed-resource draft

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:119-137`; `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:101-121`
- **Confidence:** HIGH
- **What:** Both embedded editors block navigation only when `pathname` changes. Unified Management switches its tabs by changing `?tab=` on the same pathname and unmounts the inactive editor. Managed Resources has no durable local-draft recovery, so its edits are lost immediately without a warning.
- **Evidence:** Managed Resources returns `dirty && currentLocation.pathname !== nextLocation.pathname`; Settings Policy uses the same pathname-only predicate. The parent unified surface changes `?tab=` while retaining the pathname and renders only one editor at a time. General Settings already contains the correct fork-owned comparison: when `embedded`, it also compares `currentLocation.search !== nextLocation.search`.
- **Impact:** An administrator can edit managed-resource policy, click the Settings Policy tab, and silently lose the entire unsaved policy draft. Settings Policy also violates its unsaved-warning contract, although its local recovery storage may recover the draft on return.
- **Fix:** For both editors, follow the General Settings predicate: block cross-path navigation, and when `embedded`, also block changes to `location.search`. Add component tests that render the embedded editors and evaluate `?tab=settings → ?tab=managed` in both directions.

### adm-settings-system-D5-002 — “Keep my values” clears the conflict without obtaining a current CAS token

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:201-205`; `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:232-239`; `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:307-310`; `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:371-380`; `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:581-597`
- **Confidence:** HIGH
- **What:** The conflict banner offers “Keep my values” immediately after a save/publish CAS conflict. Its handler merely clears `conflict` and unlocks the editor; it does not fetch the latest draft or replace `activeDraftToken`/`baseRevision`.
- **Evidence:** `handleKeepLocal` only calls `setConflict(false)`, clears feedback, and marks the draft dirty. The next save reuses the unchanged `activeDraftToken`, while publish reuses both the unchanged token and revision. Those are the exact stale values that caused the original conflict. Only `handleRebase` refreshes and adopts the latest token/revision.
- **Impact:** The apparent recovery action enters an endless conflict loop under normal concurrent-admin use. Administrators cannot actually preserve their values unless they choose the separately named rebase operation.
- **Fix:** Do not show “Keep my values” for the initial CAS conflict. First fetch/rebase onto the latest server snapshot; only show the action when field-level conflicts remain after that rebase, at which point the current token and revision have already been adopted.

### adm-settings-system-D1-001 — Revision-keyed Settings Policy recovery records grow without expiry or size limits

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `src/enterprise/client/features/admin/settings/localDraftStorage.ts:6-75`; `src/enterprise/client/features/admin/settings/settingsPolicyController.ts:193-239`
- **Confidence:** HIGH
- **What:** Settings Policy writes one `localStorage` entry per registry-version/base-revision pair, but never expires abandoned records, bounds serialized size, or removes older revision keys. Its conflict record also has no age validation.
- **Evidence:** `saveLocalDraft` directly serializes to `aihub.admin.settings.draft:v…:r…`; `loadLocalDraft` validates only version, revision, and `draft`. `savedAt` is stored but never checked. By contrast, the fork-owned Branding and General Settings implementations enforce a seven-day TTL, byte limits, invalid-record removal, and secret-material checks.
- **Impact:** Repeated edits across revisions accumulate indefinitely until the origin’s storage quota is exhausted. All later recovery writes are then silently ignored by the empty quota-error `catch`, disabling crash recovery across the editor without warning.
- **Fix:** Apply the existing local-draft safety pattern: enforce a seven-day TTL and maximum byte size on load/save, delete invalid or expired records, and prune older `aihub.admin.settings.draft:*` revisions after a successful write or accepted server snapshot.

### adm-settings-system-D2-001 — Tests cover generic helpers but miss the broken remediation integration paths

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/enterprise/client/features/admin/managedResources/unsavedNavigationDecision.test.ts:1-45`; `src/enterprise/client/features/admin/settings/SettingsPolicyPage.test.tsx:845-870`; `src/enterprise/client/features/admin/branding/BrandingPage.test.tsx:179-191`; `src/enterprise/client/features/admin/managedResources/SharedOAuthAuthorizationControl.refresh.test.ts:25-34`
- **Confidence:** HIGH
- **What:** Critical navigation, conflict, and partial-refresh paths remain untested at the component level despite Round-4 remediation claims.
- **Evidence:** The managed-resource “unsaved navigation” test exercises only the generic `createUnsavedNavigationDecision`; it never renders the page or evaluates its blocker predicate. Settings Policy tests only cross-path navigation. Repo-wide grep found no managed-resource test for `keepLocal` or embedded tab switching. Branding asserts that `platformRefresh` was called but never rejects it. Shared OAuth proves the mutation helper rejects, but no component test verifies user-facing failure feedback.
- **Impact:** The suite passes while both high-severity managed-resource defects and both D6 error-feedback defects remain live.
- **Fix:** Add focused component tests for embedded same-path tab changes, initial-conflict “Keep my values,” rejected runtime-branding refresh, and rejected shared-OAuth mutation. Assert retained draft/CAS state and the visible alert or toast, not merely helper calls.

### adm-settings-system-D4-001 — The zh-CN Branding surface remains extensively mixed with English

- **Severity:** MEDIUM
- **Dimension:** D4 Missing Simplified Chinese i18n coverage
- **Location:** `locales/zh-CN/admin.json:1054-1055`; `locales/zh-CN/admin.json:1078`; `locales/zh-CN/admin.json:1087-1098`; `locales/zh-CN/admin.json:1107-1124`; `src/enterprise/client/features/admin/branding/BrandingPage.tsx:205-247`
- **Confidence:** HIGH
- **What:** At least sixteen visible Branding strings retain untranslated terms such as “Branding,” “Web Branding,” and “Runtime Branding.” This is not limited to product names such as OpenAI or model IDs.
- **Evidence:** Examples include `"Branding 当前不可用。"`, `"正在加载 Branding 草稿…"`, `"Branding 预览"`, `"发布 Branding 版本"`, `"公开 Branding 保持不变"`, and `"上传受控 Branding 资源"`.
- **Impact:** The main Branding administration flow appears only partially localized to Simplified Chinese, including loading, error, publish, rollback, read-only, unsaved, and upload states.
- **Fix:** Use these exact pairs and apply the same terminology consistently to the remaining affected keys:

  - `branding.empty` — en-US: “Branding is unavailable.”; zh-CN: “品牌配置当前不可用。”
  - `branding.errors.generic` — en-US: “The branding change could not be completed. Check the fields and try again.”; zh-CN: “品牌配置操作失败，请检查字段后重试。”
  - `branding.loading` — en-US: “Loading branding draft…”; zh-CN: “正在加载品牌配置草稿…”
  - `branding.preview.frameTitle` — en-US: “Branding preview”; zh-CN: “品牌配置预览”
  - `branding.readOnly` — en-US: “You can view branding, but you do not have permission to edit it.”; zh-CN: “你可以查看品牌配置，但没有编辑权限。”
  - `branding.status.published` — en-US: “Branding published.”; zh-CN: “品牌配置已发布。”
  - `branding.unsaved.title` — en-US: “Unsaved branding changes”; zh-CN: “品牌配置有未保存的更改”
  - `branding.upload.title` — en-US: “Upload branding image”; zh-CN: “上传品牌图片”

  Translate “Web Branding” as “网页版品牌配置” and “Runtime Branding” as “运行时品牌配置”.

### adm-settings-system-D5-003 — Clean editors ignore newer SWR snapshots indefinitely

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:109-151`; `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:67-68`; `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:123-181`
- **Confidence:** HIGH
- **What:** Both editors use a one-way `hydratedRef` that permanently suppresses later server snapshots, even when the local editor is clean.
- **Evidence:** Their effects immediately return once `hydratedRef.current` is true. Managed Resources never resets the ref. Settings Policy resets it only through selected post-commit paths. Neither effect compares a new server token/revision to the accepted baseline and then chooses “hydrate if clean, mark stale if dirty,” as General Settings does.
- **Impact:** Focus revalidation or another administrator’s update can refresh SWR successfully while the screen continues showing obsolete values and CAS identity. The user receives no stale banner until a later mutation fails.
- **Fix:** Track the accepted server snapshot identity. On a new identity, hydrate immediately when clean; when dirty, preserve local work and enter an explicit stale/conflict state. Add tests for revalidation while clean and while dirty.

### adm-settings-system-D6-001 — Shared OAuth mutation failures escape without user-facing feedback

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `src/enterprise/client/features/admin/managedResources/SharedOAuthAuthorizationControl.tsx:95-139`; `src/enterprise/client/features/admin/managedResources/SharedOAuthAuthorizationControl.refresh.test.ts:25-34`
- **Confidence:** HIGH
- **What:** The confirmation handler has `try/finally` but no `catch`. A rejected `setSharedAuthorization` promise propagates after only clearing the busy state. The refresh-partial-failure branch is also styled as `toast.success`.
- **Evidence:** The helper deliberately awaits the mutation outside its refresh `try`, and its test confirms mutation rejection is rethrown. The component handles only the resolved `{ refreshFailed }` result; `finally` is the sole rejection path.
- **Impact:** Enabling or clearing organization-wide OAuth sharing can fail with no actionable toast, while a partial refresh failure is visually reported as success.
- **Fix:** Catch mutation failures and call base-ui `toast.error` with retry-oriented copy. Report committed-but-refresh-failed as warning/error, retain the committed state, and offer revalidation without rerunning the mutation.

### adm-settings-system-D6-002 — Branding publish discards the runtime-refresh result, and other post-commit refreshes are fire-and-forget

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `src/enterprise/client/features/admin/branding/BrandingPage.tsx:276-304`; `src/enterprise/client/features/admin/branding/BrandingPage.tsx:337-357`; `src/enterprise/client/features/admin/branding/BrandingPage.tsx:403-415`
- **Confidence:** HIGH
- **What:** Publish awaits both admin-draft and public-platform refreshes but destructures only the first `Promise.allSettled` result. A failed `platform.refresh()` is silently ignored. Save and rollback invoke `void mutate()` without a rejection handler.
- **Evidence:** `const [brandingRefresh] = await Promise.allSettled([mutate(), platform.refresh()])` discards the second result. The committed-refresh lock is entered only when `brandingRefresh` fails. Save and rollback end with bare `void mutate()`.
- **Impact:** Publishing can show a success notice while the visible runtime branding remains stale, with no retry affordance. Save/rollback refresh rejection can become an unhandled promise and leave history or published-state metadata stale.
- **Fix:** Inspect both settled results. Treat mutation success as authoritative, but surface a persistent warning and retry action when either projection fails. Attach handled rejection paths to save/rollback refreshes.

### adm-settings-system-D1-002 — SettingsPolicyPage test file exceeds the repository’s split threshold

- **Severity:** LOW
- **Dimension:** D1 Code smells
- **Location:** `src/enterprise/client/features/admin/settings/SettingsPolicyPage.test.tsx:1-872`
- **Confidence:** HIGH
- **What:** The test file is 872 lines, exceeding the repository guideline to split files past approximately 800 lines.
- **Evidence:** `wc -l` reports 872 lines. It mixes permissions, CAS conflicts, publish/reset, refresh recovery, search localization, and navigation-guard scenarios in one suite.
- **Impact:** The monolithic fixture/mocking surface helped leave important embedded-navigation behavior untested and makes future remediation harder to review.
- **Fix:** Split by behavior, for example permissions/rendering, save/publish CAS, reset/recovery, and search/navigation. Share only minimal typed fixtures.

### adm-settings-system-D3-001 — Several symbols are exported despite having no external consumer

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `src/enterprise/client/features/admin/branding/useAdminBranding.ts:7`; `src/enterprise/client/features/admin/branding/localDraftStorage.ts:16-23`; `src/enterprise/client/features/admin/generalSettings/generalSettingsHydration.ts:6-13`
- **Confidence:** HIGH
- **What:** Internal implementation details are exposed as module APIs without callers.
- **Evidence:** Repo-wide searches outside their defining files found no consumers of `ADMIN_BRANDING_DRAFT_KEY`, `buildBrandingLocalDraftKey`, `BrandingLocalDraft`, `GeneralSettingsDraftSnapshot`, or `GeneralSettingsHydrationDecision`.
- **Impact:** These unnecessary exports enlarge the apparent supported API and make later refactoring noisier.
- **Fix:** Remove `export` from internal constants, helpers, and types unless a real cross-module consumer is introduced.

### adm-settings-system-D7-001 — Branding copy exposes implementation language instead of an actionable outcome

- **Severity:** LOW
- **Dimension:** D7 Overly technical / internal-state-leaking UI strings
- **Location:** `src/enterprise/client/features/admin/branding/BrandingPage.tsx:335-369`; `src/enterprise/client/features/admin/branding/BrandingPage.tsx:538-540`; `src/enterprise/client/features/admin/branding/BrandingPage.tsx:476-479`; `locales/en-US/admin.json:1095`; `locales/en-US/admin.json:1117`
- **Confidence:** HIGH
- **What:** Administrators are shown phrases such as “anonymous Runtime Branding snapshot,” “controlled existing asset URLs,” “uploads fail closed,” and server-side byte/container validation. These explain internals rather than what the user can do.
- **Evidence:** The strings are rendered directly in the publish modal, storage warning, and upload modal.
- **Impact:** The copy is difficult to act on and makes an ordinary branding workflow sound like an infrastructure/debug interface.
- **Fix:** Use exact plain-language replacements:

  - Publish description — en-US: “Publish the saved branding draft for everyone.”; zh-CN: “向所有用户发布已保存的品牌配置草稿。”
  - Storage warning — en-US: “Asset storage is not set up. You can still edit text and use existing image links, but you cannot upload new images.”; zh-CN: “资源存储尚未设置。你仍可编辑文字并使用现有图片链接，但暂时无法上传新图片。”
  - Upload description — en-US: “We’ll check the image format and size before uploading it.”; zh-CN: “上传前会检查图片格式和尺寸。”

### adm-settings-system-D7-002 — Policy UI exposes machine paths, revision counters, and “rebase” jargon

- **Severity:** LOW
- **Dimension:** D7 Overly technical / internal-state-leaking UI strings
- **Location:** `src/enterprise/client/features/admin/settings/SettingsPolicyGroupGrid.tsx:112-119`; `src/enterprise/client/features/admin/settings/SettingsPolicyPage.tsx:302-311`; `src/enterprise/client/features/admin/settings/SettingsPolicyConflictBanner.tsx:56-60`; `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:581-597`; `locales/en-US/admin.json:1561-1565`; `locales/en-US/admin.json:1744`; `locales/en-US/admin.json:1916`
- **Confidence:** HIGH
- **What:** Every setting card displays its internal registry path, the footer exposes CAS revision numbers, and the managed-resource recovery action uses Git/database terminology (“Refresh and rebase”).
- **Evidence:** The UI renders `entry.path` in a monospaced block, `settingsPolicy.revision`, two raw revision numbers in conflict copy, and `managedResources.conflict.rebase`.
- **Impact:** Administrators are given implementation identifiers that do not help them resolve the conflict and may mistake “rebase” for a destructive or developer-only operation.
- **Fix:** Remove the raw path from the default card and place it, if necessary, behind an advanced diagnostic affordance. Use:

  - Settings conflict — en-US: “This policy changed elsewhere while you were editing. Review the latest values before continuing.”; zh-CN: “你编辑期间，此策略已在其他位置发生变化。请先查看最新值，再继续操作。”
  - Clean footer — en-US: “Saved settings are up to date”; zh-CN: “已同步最新保存内容”
  - Managed conflict description — en-US: “Another administrator changed this policy. Merge your edits with the latest changes, or discard them.”; zh-CN: “其他管理员已修改此策略。请将你的编辑与最新修改合并，或放弃本地修改。”
  - Action — en-US: “Merge with latest changes”; zh-CN: “与最新修改合并”

### adm-settings-system-D8-001 — Enabling the email allowlist causes an abrupt card-height jump

- **Severity:** LOW
- **Dimension:** D8 Missing animations / motion
- **Location:** `src/enterprise/client/features/admin/generalSettings/GeneralSettingsPage.tsx:417-440`
- **Confidence:** HIGH
- **What:** Toggling the allowlist directly mounts/unmounts the multi-line editor and hint, abruptly changing the card height.
- **Evidence:** The `TextArea` subtree is controlled by a plain ternary with no transition or reduced-motion treatment.
- **Impact:** The switch produces a visible layout pop and moves surrounding controls without continuity.
- **Fix:** Keep the content in an antd-style reveal wrapper and transition `grid-template-rows` and opacity using `cssVar.motionDurationMid` and `cssVar.motionEaseInOut`. Add `@media (prefers-reduced-motion: reduce) { transition: none; }`. This uses the existing upstream styling system and adds no animation dependency.

## Dimensions with no findings

None; each of D1–D8 has at least one verified finding.

## Cross-scope notes

`src/enterprise/client/features/admin/unified/UnifiedManagementPage.tsx:63-73` owns the same-path `?tab=` switch that exposes D5-001. Its tab-change integration tests should be updated alongside the in-scope editor blockers so the parent/child navigation contract cannot drift again.
