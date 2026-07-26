# Round 5 Audit — fe-user-surface

## Scope

Audited the fork-owned delta from `4bab1636408e60a7ee17b640490fbf33a310a325` to `HEAD` across:

`src/routes`, `src/features`, `src/store`, `src/services`, `src/business`, `src/app`, `src/libs`, `src/spa`, `src/hooks`, `src/utils`, `src/const`, and `src/types`.

The delta contains 431 files: 161 added and 270 modified, comprising 24,707 insertions and 2,956 deletions (27,663 changed lines). Of these, 103 are tests and 328 are non-test files. Breakdown: 145 `src/features`, 144 `src/routes`, 42 `src/store`, 38 `src/libs`, 23 `src/app`, 19 `src/services`, 9 `src/business`, 6 `src/hooks`, 2 `src/utils`, 2 `src/spa`, and 1 `src/types`. `src/const` had no baseline-to-HEAD delta.

Byte-identical upstream files were excluded. Admin-only behavior nested under these roots was excluded unless it interacted with an end-user seam. The audit was static and read-only; no tests, linters, formatters, or write-capable commands were run.

## Summary

| Dimension                                             | Findings | Highest severity |
| ----------------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                        |        1 | MEDIUM           |
| D2 Test decay                                         |        3 | MEDIUM           |
| D3 Dead code and development debris                   |        1 | MEDIUM           |
| D4 Missing Simplified Chinese i18n coverage           |        0 | —                |
| D5 Potential functional bugs                          |        2 | HIGH             |
| D6 Warnings and errors not surfaced via toast         |        1 | MEDIUM           |
| D7 Overly technical/internal-state-leaking UI strings |        1 | LOW              |
| D8 Missing animations/motion                          |        1 | LOW              |

## Findings

### fe-user-surface-D5-1 — Managed per-user Connector authorization is implemented but unreachable

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/routes/(main)/settings/connector/index.tsx:3-8`; `src/routes/(main)/[workspaceSlug]/settings/connector/index.tsx:3-8`; `src/features/PlatformConnectorAuthorization/ManagedConnectorSettings.tsx:12-20`; `src/features/PlatformConnectorAuthorization/index.ts:1-2`; `src/features/PlatformConnectorAuthorization/PlatformConnectorAuthorization.tsx:31-167`; `src/features/PlatformConnectorAuthorization/ConnectorCard.tsx:138-165`; `src/features/ManagedResources/managedResourcePresentation.ts:11-20`
- **Confidence:** HIGH
- **What:** Both production Connector settings routes wrap ordinary settings in `ManagedConnectorSettings`. When Connectors are platform-managed, that wrapper renders a managed-resource notice instead of the dedicated `PlatformConnectorAuthorization` surface. The authorization component is exported but has no production caller.
- **Evidence:** `ManagedConnectorSettings` explicitly says per-user OAuth must not remain on this entry path and to “ship a dedicated surface later if needed,” then delegates to `ManagedResourceBoundary`. That boundary replaces its children with `ManagedResourceNotice` whenever the resource is managed. A repo-wide reference search found only the component’s export and its unit test—no route imports it. Meanwhile, `ConnectorCard` exposes Connect/Reauthorize/Disconnect only for `credentialMode === 'per_user_oauth'`. The notice’s Browse action leads to `/community/mcp`, whose public marketplace installation flow does not invoke the enterprise authorization client.
- **Impact:** Users cannot connect their own account to an organization-published `per_user_oauth` Connector. The Connector is visible to the runtime/catalog but unusable for the user who must supply personal OAuth credentials.
- **Fix:** Make the personal and workspace Connector routes branch on managed-resource state: render `PlatformConnectorAuthorization` when Connectors are managed and retain `ToolSettings` only when unmanaged. Preserve the active workspace context and current pathname for OAuth return handling.

### fe-user-surface-D5-2 — A later settings write can cancel and discard an earlier edit from another settings group

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/store/user/slices/settings/action.ts:72-81`; `src/store/user/slices/settings/action.ts:89-105`; `src/store/user/slices/settings/action.ts:189-215`
- **Confidence:** HIGH
- **What:** `setSettings` optimistically merges every edit into local state, but persists only the top-level groups changed by the current invocation. Every invocation also aborts the preceding request. Consequently, a newer edit in a different top-level group can cancel the only request carrying the earlier edit without including that edit in its own payload.
- **Evidence:** Lines 196-200 build `updates` exclusively from `Object.keys(changedFields)`. Lines 202-204 create a new signal—aborting the previous one—and send only those groups. For example, an optimistic `{ memory: ... }` request can be aborted by a subsequent `{ general: ... }` request; the second payload contains only `general`. Its successful `refreshUserState()` then reloads the server’s old `memory` value and overwrites the optimistic edit. The older aborted request deliberately skips rollback because it no longer owns `updateSettingsSignal`.
- **Impact:** Users making rapid edits across settings sections can see an earlier change appear saved and then silently revert. This is especially likely in autosaving forms or while quickly changing model, memory, speech, and appearance settings.
- **Fix:** Track pending dirty top-level groups and coalesce them into the newest request, or maintain independent abort/serialization queues per top-level group. Preserve the policy requirement not to resend unrelated credential-bearing groups. Add a regression test with two different top-level groups and a server-backed refresh.

### fe-user-surface-D2-1 — Connector tests manufacture the missing route and assert the broken guard instead of production behavior

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/features/PlatformConnectorAuthorization/PlatformConnectorAuthorization.test.tsx:94-105`; `src/routes/(main)/settings/features/componentMap.sync.test.ts:26-39`; `src/routes/(main)/settings/connector/index.tsx:3-8`; `src/routes/(main)/[workspaceSlug]/settings/connector/index.tsx:3-8`
- **Confidence:** HIGH
- **What:** Existing tests cannot detect that the managed authorization component is unreachable. One test creates an artificial `/settings/connector` memory route containing the component directly. Another only reads the two real route files as text and requires them to contain `ManagedConnectorSettings` plus the ordinary `ToolSettings` fallback.
- **Evidence:** `renderAt()` installs `<PlatformConnectorAuthorization />` into a test-only router rather than importing either production route. The component-map test asserts string presence without rendering managed capability state or checking for an authorization action. A repo-wide test search found no production-route test that enables managed Connectors and asserts the per-user OAuth UI.
- **Impact:** The Round-4 route remediation can pass all targeted tests while the core managed Connector authorization flow remains inaccessible.
- **Fix:** Render the actual personal and workspace route components under managed and unmanaged enterprise capability fixtures. Assert that managed mode exposes Connect/Reauthorize for `per_user_oauth`, while unmanaged mode renders ordinary `ToolSettings`.

### fe-user-surface-D2-2 — The settings concurrency test passes without exercising cross-group persistence or refresh

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/store/user/slices/settings/action.test.ts:152-184`; `src/store/user/slices/settings/action.ts:189-215`
- **Confidence:** HIGH
- **What:** The regression test for superseded settings writes uses two fields under the same `general` group and mocks `refreshUserState` to a no-op. It therefore verifies only optimistic in-memory state, not what survives on the server.
- **Evidence:** The test writes `general.fontSize` followed by `general.responseLanguage`. Because both are under `general`, the second request happens to serialize the complete merged `general` group and carries the first edit. The missing case is two different top-level groups, where `updates` excludes the first group. Mocking refresh prevents stale server state from exposing the loss.
- **Impact:** The test gives false confidence in the abort/rollback remediation and permits the data-loss race in `setSettings`.
- **Fix:** Use distinct top-level groups, such as `memory` followed by `general`. Model server persistence in the mock, let refresh replace local state from that persistence layer, and assert both values survive after the first request is aborted.

### fe-user-surface-D1-1 — Enterprise skill arbitration further expands a 2,191-line hook

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `src/features/ChatInput/ActionBar/Tools/useControls.tsx:434-2191`; `src/features/ChatInput/ActionBar/Tools/useControls.tsx:826-865`; `src/features/ChatInput/ActionBar/Tools/useControls.tsx:1401-1458`; `src/features/ChatInput/ActionBar/Tools/useControls.tsx:1602-1665`
- **Confidence:** HIGH
- **What:** `useControls` remains a single 2,191-line hook responsible for store subscriptions, fetching, platform-vs-legacy arbitration, policy rendering, searching, grouping, mutations, modal state, and output construction. The fork added 180 lines and removed 31, taking an already oversized 2,042-line upstream file farther beyond the repository’s approximately 800-line split guideline.
- **Evidence:** Enterprise platform state is subscribed and arbitrated at lines 826-865, transformed into UI items at 1401-1458, and then woven into grouping, deduplication, and pinning logic at 1602-1665. Equivalent Profile Editor work was extracted into `useManagedAgentSkills` and `ManagedSkillToolItems`, but the chat-input path retains the same responsibility inside the monolithic hook.
- **Impact:** Platform policy, Connector, marketplace, and ordinary plugin behavior remain tightly coupled. Small enterprise changes require touching a high-churn hook with many dependency arrays and ordering assumptions, increasing regression and review risk.
- **Fix:** Extract a chat-input managed-skill hook analogous to `useManagedAgentSkills`, plus a presentation builder for platform items and unavailable-state actions. Keep `useControls` responsible only for composing canonical item groups and returning menu state.

### fe-user-surface-D3-1 — Round-4’s provider-settings extraction created a dead 4,231-line parallel implementation

- **Severity:** MEDIUM
- **Dimension:** D3 Dead code and development debris
- **Location:** `src/features/SettingsProvider/ModelList/CreateNewModelModal/ExtendParamsSelect.tsx:1-630`; `src/features/SettingsProvider/ModelList/DisabledModels.tsx:1-324`; `src/features/SettingsProvider/ProviderConfig/OAuthDeviceFlowAuth/index.tsx:1-397`; `src/features/SettingsProvider/const.ts:1-20`; `src/routes/(main)/settings/provider/detail/default/index.tsx:9-11`; `src/routes/(main)/settings/provider/detail/default/CustomProviderDetail.tsx:15-16`
- **Confidence:** HIGH
- **What:** Commit `eb7fcbb87c` copied provider-settings business UI into `src/features/SettingsProvider`, but production routes were never rewired. The entire new feature tree is unused.
- **Evidence:** The tree contains 35 files and 4,231 lines. Byte-for-byte comparison found 27 production files totaling 3,680 lines and seven tests totaling 531 lines identical to counterparts under `src/routes/(main)/settings/provider/features`; only the 20-line `const.ts` has no peer. Repo-wide reference searches found no imports from `@/features/SettingsProvider`. The live default and custom provider detail routes still import `../../features/ModelList` and `../../features/ProviderConfig`.
- **Impact:** Fixes can land in the apparently canonical feature tree without affecting production. The duplicate implementation also doubles review surface and invites silent divergence between route-owned and feature-owned behavior.
- **Fix:** Complete the extraction: add explicit feature exports, rewire provider route segments to `@/features/SettingsProvider`, and delete the route-local copies. If extraction is no longer intended, remove the unused feature tree instead.

### fe-user-surface-D6-1 — Managed-skill retry failures are fire-and-forget in both end-user tool pickers

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `src/features/ProfileEditor/useManagedAgentSkills.ts:111-115`; `src/features/ProfileEditor/ManagedSkillToolItems.tsx:93-120`; `src/features/ChatInput/ActionBar/Tools/useControls.tsx:1431-1458`
- **Confidence:** HIGH
- **What:** Both retry buttons invoke the platform catalog SWR mutation without awaiting or catching it. Failed retries leave the same “unavailable” row on screen with no toast explaining that the explicit retry failed.
- **Evidence:** `retryPlatformCatalog` is typed as returning `void` and calls `void mutateCatalog()`. `ManagedSkillToolItems` invokes it directly from the Retry button. The chat-input picker independently calls `void platformCatalogSWR.mutate()`. The catalog fetch path rethrows its error, so the ignored promise can also become an unhandled rejection. By contrast, the adjacent platform-skill toggle path already catches failures and uses `toast.error`.
- **Impact:** Users whose organization skill catalog is temporarily unavailable can repeatedly click Retry with no actionable feedback and no distinction between a running retry and another failed attempt.
- **Fix:** Return and await the mutation promise, catch rejection in both surfaces, and use `toast.error` from `@lobehub/ui/base-ui`. Suggested copy: en-US “Couldn’t refresh organization skills. Try again.”; zh-CN “无法刷新组织技能，请重试。”

### fe-user-surface-D2-3 — Seven provider-settings test suites are exact duplicates

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/features/SettingsProvider/ModelList/CreateNewModelModal/__tests__/ExtendParamsSelect.test.tsx:1-93`; `src/routes/(main)/settings/provider/features/ModelList/CreateNewModelModal/__tests__/ExtendParamsSelect.test.tsx:1-93`; `src/features/SettingsProvider/ModelList/CreateNewModelModal/__tests__/utils.test.ts:1-17`; `src/routes/(main)/settings/provider/features/ModelList/CreateNewModelModal/__tests__/utils.test.ts:1-17`; `src/features/SettingsProvider/ModelList/DisabledModels.scoped.test.tsx:1-140`; `src/routes/(main)/settings/provider/features/ModelList/DisabledModels.scoped.test.tsx:1-140`; `src/features/SettingsProvider/ModelList/ModelTitle/Search.test.tsx:1-53`; `src/routes/(main)/settings/provider/features/ModelList/ModelTitle/Search.test.tsx:1-53`; `src/features/SettingsProvider/ModelList/ProviderSettingsContext.test.tsx:1-74`; `src/routes/(main)/settings/provider/features/ModelList/ProviderSettingsContext.test.tsx:1-74`; `src/features/SettingsProvider/ModelList/SearchResult.test.tsx:1-72`; `src/routes/(main)/settings/provider/features/ModelList/SearchResult.test.tsx:1-72`; `src/features/SettingsProvider/ProviderConfig/UpdateProviderInfo/normalizeProviderSettings.test.ts:1-82`; `src/routes/(main)/settings/provider/features/ProviderConfig/UpdateProviderInfo/normalizeProviderSettings.test.ts:1-82`
- **Confidence:** HIGH
- **What:** The unfinished provider extraction duplicated seven complete test suites, totaling 531 lines, alongside the duplicated implementation.
- **Evidence:** All seven feature-tree tests are byte-identical to their route-tree counterparts. They therefore do not test two implementations or migration compatibility; they execute the same assertions against two copied module paths.
- **Impact:** Test runtime and maintenance cost increase without coverage gain. Future changes can update only one copy, producing contradictory results or allowing the production tree and dead feature tree to diverge.
- **Fix:** Retain one canonical suite alongside the canonical implementation after completing or reverting the extraction. Do not preserve mirrored tests merely to cover both duplicate directories.

### fe-user-surface-D7-1 — “Headless” exposes an internal execution-mode term in a locked end-user control

- **Severity:** LOW
- **Dimension:** D7 Overly technical/internal-state-leaking UI strings
- **Location:** `src/features/ChatInput/ControlBar/ApprovalMode.tsx:75-85`; `src/features/ChatInput/ControlBar/ApprovalMode.tsx:140-145`; `packages/locales/src/default/chat.ts:1176-1178`; `locales/en-US/chat.json:1059-1060`; `locales/zh-CN/chat.json:1057-1058`
- **Confidence:** HIGH
- **What:** A platform-controlled approval mode is rendered as “Headless,” with a tooltip describing “organization-managed unattended execution” and “unsafe tools.” These are implementation and policy terms rather than a plain explanation of what the user can expect.
- **Evidence:** `ApprovalMode` displays the raw `headless` label when platform metadata is enabled and the raw mode is `headless`. Because the field is locked, the tooltip is the user’s only explanation and provides no action.
- **Impact:** Ordinary users may not understand “headless” or how “unsafe” is determined, and may interpret the mode as a malfunction rather than an organization policy.
- **Fix:** Replace the copy with:
  - **en-US label:** “Managed by your organization”
  - **en-US description:** “Your organization allows approved tools to run automatically and blocks tools that do not meet its safety rules.”
  - **zh-CN label:** “由组织管理”
  - **zh-CN description:** “组织允许已批准的工具自动运行，并会阻止不符合安全规则的工具。”

### fe-user-surface-D8-1 — Managed-resource loading, notice, error, and content states replace the full page abruptly

- **Severity:** LOW
- **Dimension:** D8 Missing animations/motion
- **Location:** `src/features/ManagedResources/ManagedResourceBoundary.tsx:17-23`; `src/features/ManagedResources/ManagedResourceNotice.tsx:14-28`; `src/features/ManagedResources/ManagedResourceNotice.tsx:55-76`
- **Confidence:** HIGH
- **What:** The boundary conditionally returns four unrelated full-page subtrees with no transition. When capability loading resolves, the branded loader immediately becomes a 320-pixel managed notice or the full settings page, producing a visible pop and possible layout jump.
- **Evidence:** Lines 20-23 are four immediate returns for error, loading, managed, and children. Neither the boundary nor notice defines an entry transition, despite the notice changing both page height and content hierarchy.
- **Impact:** Managed settings navigation feels unstable, particularly on slower capability requests where the branded loader remains visible long enough for the abrupt replacement to be noticeable.
- **Fix:** Wrap each keyed state in an `@lobehub/ui` `Flexbox` and add a short opacity/translate entry animation with `createStaticStyles`, `cssVar.motionDurationMid`, and `cssVar.motionEaseInOut`. Disable the animation under `@media (prefers-reduced-motion: reduce)`. No new animation dependency is needed.

## Dimensions with no findings

- **D4 Missing Simplified Chinese i18n coverage:** Checked the fork-added end-user namespaces used by managed resources, platform Connectors, platform skills, platform setting-source indicators, and the new approval mode. The en-US and zh-CN key sets match for these prefixes, and the zh-CN values were neither empty nor still-English.

## Cross-scope notes

The locale-domain auditor should inspect new English-only metadata outside this assignment: `locales/en-US/models.json:684-686` and `locales/en-US/models.json:709` add GPT-5.6 and Grok 4.5 descriptions, while `locales/en-US/providers.json:67` adds the SuperGrok description; no corresponding keys were found in the zh-CN files.
