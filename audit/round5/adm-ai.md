# Round 5 Audit — adm-ai

## Scope

Audited all fork-owned changes under:

- `src/enterprise/client/features/admin/ai`
- `src/enterprise/client/services/adminAiInfraAdapter`
- `src/enterprise/client/services/adminAiCatalog.ts`
- `src/enterprise/client/services/adminAiCatalog.test.ts`
- `src/features/ServiceModel`
- `src/features/SettingsProvider`

The baseline diff contains 110 files: 17,412 added lines and 263 deleted lines. All 110 files differ from baseline; no byte-identical files inside the assigned paths were included. Surrounding route components, server schemas, and the settings registry were read only to verify scoped seams and callers.

## Summary

| Dimension                                     | Findings | Highest severity |
| --------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                |        1 | MEDIUM           |
| D2 Test decay                                 |        2 | MEDIUM           |
| D3 Dead code and development debris           |        1 | MEDIUM           |
| D4 Missing Simplified Chinese i18n coverage   |        1 | LOW              |
| D5 Potential functional bugs                  |        3 | HIGH             |
| D6 Warnings and errors not surfaced via toast |        2 | MEDIUM           |
| D7 Overly technical UI strings                |        1 | LOW              |
| D8 Missing animations / motion                |        1 | LOW              |

## Findings

### adm-ai-D5-01 — Managed service-model policies remain editable for 24 of 28 system-agent paths

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/features/ServiceModel/ModelAssignmentsForm.tsx:41-56`; `src/features/ServiceModel/ModelAssignmentsFormView.tsx:154-190`; `src/features/ServiceModel/ModelAssignmentsFormView.tsx:224-340`
- **Confidence:** HIGH
- **What:** The user Service Model wrapper only loads platform-policy metadata for four system-agent paths: topic model/provider, translation model, and history-compression model. The remaining registered model, provider, enabled, and context-limit paths render as ordinary editable controls even when hidden or locked by platform policy.
- **Evidence:** The server registry defines model and provider policies for 11 system agents, plus three `enabled` and three `contextLimit` paths—28 paths total. The wrapper builds `systemAgentMetas` for only three agents and omits translation/history provider metadata. `ModelAssignmentsFormView` defaults missing metadata to `[]`, which passes its mutation guard. Memory and optional-feature controls also render without consulting `ManagedCompositeSettingFieldContent`.
- **Impact:** For policies such as `systemAgent.agentMeta.provider`, `systemAgent.followUpAction.enabled`, or `systemAgent.userMemoryEmbedding.contextLimit`, users see enabled controls and can initiate writes despite the setting being centrally managed. The personal value can appear saved while the effective platform value remains unchanged, undermining the managed-settings certainty and fail-closed behavior.
- **Fix:** Build metadata for every registered system-agent leaf path. Pass field-level model/provider/enabled/context metadata into the view, hide rows when any governing policy is hidden, and disable each affected control when loading, errored, or locked. Add table-driven tests across all 28 paths and all `default`, `locked`, and hidden modes.

### adm-ai-D5-02 — The “Unlimited” context-window option sends a value rejected by the admin API

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/enterprise/client/services/adminAiInfraAdapter/AdminAiModelService.ts:36-52`; `src/enterprise/client/services/adminAiInfraAdapter/AdminAiModelService.ts:108-126`; `src/enterprise/client/services/adminAiInfraAdapter/AdminAiModelService.ts:131-145`
- **Confidence:** HIGH
- **What:** The shared model editor represents “Unlimited” as `0`, but the admin adapter forwards `0` unchanged. The admin contract accepts only positive integers or `null`.
- **Evidence:** `createAiModel` uses `params.contextWindowTokens ?? null`, `updateAiModel` uses `value.contextWindowTokens ?? undefined`, and batch update uses `m.contextWindowTokens ?? null`; all preserve `0`. The reused `MaxTokenSlider` emits `0` for its Unlimited position, while `adminAiModelApplyImmediateInputSchema` validates `contextWindowTokens` with `z.number().int().positive().nullable()`.
- **Impact:** Choosing a visible, normal form option makes model creation, editing, or batch updates fail validation. Updating with an explicit `null` also becomes `undefined`, so the single-model update path cannot reliably clear a previously configured limit.
- **Fix:** Normalize the shared UI sentinel at the adapter boundary: map `0` to `null` for create, update, and batch update; preserve explicit `null` on update instead of collapsing it to `undefined`. Add contract-facing tests for positive, omitted, `null`, and `0` values.

### adm-ai-D5-03 — Concurrent provider creation can navigate to or retry the wrong provider

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/enterprise/client/features/admin/ai/mutationRefresh.ts:9-23`; `src/enterprise/client/features/admin/ai/providers/ProviderListPage.tsx:56-58`; `src/enterprise/client/features/admin/ai/providers/ProviderListPage.tsx:228-256`; `src/enterprise/client/features/admin/ai/providers/ProviderListPage.tsx:298-309`; `src/enterprise/client/features/admin/ai/providers/openCreateProviderModal.tsx:136-149`
- **Confidence:** HIGH
- **What:** Provider creation resolves and closes its modal as soon as the write commits, while refresh continues detached. The page keeps only one `committedProviderId`, does not disable Create while refresh is pending, and allows another creation to overwrite that slot.
- **Evidence:** `commitThenScheduleRefresh` invokes refresh in an unawaited promise chain. `openCreateProviderModal` closes after `onSubmit` resolves. The Create button has no disabled/loading condition tied to `committedProviderId`. Each refresh callback independently clears the shared ID and navigates using its captured local ID.
- **Impact:** If a second provider is created before the first refresh settles, the first callback can clear the second provider’s retry identity or navigate away to the first provider. A later refresh failure can then show an alert whose Retry button has no provider ID to act on.
- **Fix:** Treat committed refresh as a page-level write lock: disable Create and other conflicting navigation until it settles or fails. Alternatively track refresh state by operation/provider ID and ignore stale callbacks. Add a component test with two deferred, out-of-order refresh promises.

### adm-ai-D6-01 — Governance fetch failures silently degrade connector permissions to defaults

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:142-150`; `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:170-190`; `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:236-271`; `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:581-589`
- **Confidence:** HIGH
- **What:** A failed `getGovernance()` request is excluded from both `listError` and `listLoading`. The page therefore renders built-in tools with fallback `auto` permissions and merely makes them read-only, without telling the administrator that the real governance matrix failed to load.
- **Evidence:** `governanceSWR.error` is not part of `listError`; only connector list, detail, and partial-detail errors are included. Missing governance makes `builtinToolPolicies` undefined, so every built-in permission falls back to `ConnectorToolPermission.auto`. The underlying `getGovernance` read has no service-level toast wrapper.
- **Impact:** Administrators can mistake fallback values for the organization’s actual connector policy. There is no visible error or actionable Retry surface even though `retry()` already knows how to refetch governance.
- **Fix:** Include `governanceSWR.error` in `listError` and its unresolved state in `listLoading`. Emit a coalesced `toast.error` from `@lobehub/ui/base-ui` with plain copy such as “Connector permissions could not be loaded. Retry before making changes,” and expose the existing Retry action.

### adm-ai-D6-02 — Partial provider-order publication is overwritten and reported as success

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `src/enterprise/client/services/adminAiInfraAdapter/index.ts:214-247`; `src/enterprise/client/services/adminAiInfraAdapter/shared.ts:23-55`; `src/enterprise/client/features/admin/ai/providerSettings/DraftPublishBanner.tsx:20-34`
- **Confidence:** HIGH
- **What:** Provider ordering performs sequential, independently published writes but neither aggregates soft failures nor reports the failed subset. Each result overwrites a singleton “last publish outcome.”
- **Evidence:** `updateAiProviderOrder` loops over providers and calls `recordPublishOutcome` after every `applyImmediate`. A result with `published: false` does not reject. `AdminPublishOutcomeStore` retains only one outcome, so a later successful provider overwrites an earlier failed publication. The reused sort modal then resolves normally and displays its success message.
- **Impact:** The administrator can be told that ordering succeeded even though one or more providers retained only draft sort values. The published organization order can differ from the order shown after editing, with no indication of which providers failed.
- **Fix:** Return or throw an aggregate result containing every soft failure. Keep outcomes keyed by provider rather than a singleton, leave the sort modal open on partial success, and use `toast.warning` from `@lobehub/ui/base-ui` with the failed count/provider names and a retry action. Test early, middle, and final soft failures.

### adm-ai-D3-01 — The SettingsProvider “extraction” added 4,231 lines that no consumer imports

- **Severity:** MEDIUM
- **Dimension:** D3 Dead code and development debris
- **Location:** `src/features/SettingsProvider/CreateNewProvider/index.tsx:1-36`; `src/features/SettingsProvider/ModelList/ModelItem.tsx:1-326`; `src/features/SettingsProvider/ProviderConfig/Checker.tsx:1-311`; `src/features/SettingsProvider/providerSettings.ts:1-73`; `src/enterprise/client/features/admin/ai/providerSettings/ProviderSettingsPage.tsx:11-15`
- **Confidence:** HIGH
- **What:** Commit `eb7fcbb87c` copied a complete provider-settings feature tree into `src/features/SettingsProvider` but did not switch any consumer to it.
- **Evidence:** The directory contains 35 files and 4,231 lines. Thirty-four files are byte-identical to files still under `src/routes/(main)/settings/provider/features`; the remaining file is unique support data. A repo-wide reference search finds no import of `@/features/SettingsProvider`. The admin page still imports its detail UI, menu, grid, and context from the old route tree.
- **Impact:** The repository now has two implementations and duplicate tests, while fixes applied to one tree can silently miss the live tree. It also makes the claimed roots-versus-features migration appear complete when production still uses the route-owned implementation.
- **Fix:** Complete the migration by adding an explicit feature entry point, switching every live consumer, verifying the route files are thin delegators, and then removing the old implementation. If the migration is not ready, remove the unused copy instead.

### adm-ai-D1-01 — One hook owns the entire skills and connectors administration subsystem

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:82-914`
- **Confidence:** HIGH
- **What:** `useAdminGlobalToolScope` is a 914-line hook combining paginated reads, data mapping, capability derivation, skill import/install/delete, connector discovery/create/delete, governance mutation, permission reset, toast policy, and detail hooks.
- **Evidence:** The file exceeds the repository’s approximately 800-line split guideline and contains 27 `useCallback` occurrences and 25 direct admin service-call lines. The Round-4 remediation substantially expanded this hook, including several independent error-handling conventions and mutation workflows.
- **Impact:** A change to one domain can disturb hook dependencies, error propagation, or refresh behavior in the other. The omitted governance error is an example of state introduced in one section but not incorporated into shared loading/error derivation.
- **Fix:** Split it into focused hooks such as `useAdminSkillScope`, `useAdminConnectorCatalog`, `useAdminConnectorGovernance`, and mutation/toast adapters. Keep a small composition hook that returns the `AdminToolScope` contract.

### adm-ai-D2-01 — The refresh-lock regression test never exercises the Provider list page

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/enterprise/client/features/admin/ai/mutationRefresh.test.ts:58-111`; `src/enterprise/client/features/admin/ai/providers/ProviderListPage.test.tsx:78-102`; `src/enterprise/client/features/admin/ai/providers/ProviderListPage.test.tsx:192-246`
- **Confidence:** HIGH
- **What:** Two tests claim Provider actions remain locked during or after committed refresh, but they only manipulate local booleans and call `isAiProviderWriteLocked`. They never render `ProviderListPage`, which does not use that helper for its Create action.
- **Evidence:** The tests define `refreshPending`, `refreshFailed`, and an artificial `tryAction` entirely inside the test. The actual page test mocks `openCreateProviderModal` and only tests hard-delete visibility; it contains no create or committed-refresh assertion.
- **Impact:** The suite passes while the concrete concurrent-create race remains present. The test name gives false confidence that the Round-4 committed-refresh remediation covers every Provider action.
- **Fix:** Replace the local-state test with a component test that opens the real create callback, commits a provider, holds refresh pending, and asserts the page’s Create action is disabled. Also cover refresh failure, Retry, and out-of-order callbacks.

### adm-ai-D2-02 — Critical managed-policy and Unlimited-token branches have no regression coverage

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/enterprise/client/services/adminAiInfraAdapter/AdminAiModelService.test.ts:39-99`; `src/enterprise/client/services/adminAiInfraAdapter/AdminAiModelService.test.ts:118-209`; `src/features/ServiceModel/ModelAssignmentsForm.tsx:41-56`; `src/features/ServiceModel/ModelAssignmentsFormView.tsx:94-190`
- **Confidence:** HIGH
- **What:** Neither high-risk seam has a test: `src/features/ServiceModel` has no test file, and the model adapter suite never passes `contextWindowTokens: 0` or explicit `null`.
- **Evidence:** The adapter fixtures only contain `contextWindowTokens: null`; its create test omits the field entirely. Repo-wide search found no `0`/Unlimited case and no test for `systemAgentMetas`, hidden policies, or locked policies. The three ServiceModel files have zero colocated tests.
- **Impact:** Contract incompatibilities and policy-lock omissions can ship despite apparently strong CAS and publish-outcome coverage.
- **Fix:** Add table-driven adapter tests for token normalization and controlled-form tests for every policy-bearing control. Include loading/error fail-closed behavior and assertions that locked or hidden paths never invoke update callbacks.

### adm-ai-D4-01 — Model types and Provider sources are rendered as untranslated enum values

- **Severity:** LOW
- **Dimension:** D4 Missing Simplified Chinese i18n coverage
- **Location:** `src/enterprise/client/features/admin/ai/models/ModelListPage.tsx:41-50`; `src/enterprise/client/features/admin/ai/models/ModelListPage.tsx:147-151`; `src/enterprise/client/features/admin/ai/models/ModelListPage.tsx:297-305`; `src/enterprise/client/features/admin/ai/models/ProviderModelsSection.tsx:99-109`; `src/enterprise/client/features/admin/ai/models/openModelEditorModal.tsx:223-240`; `src/enterprise/client/features/admin/ai/providers/ProviderListPage.tsx:107-111`
- **Confidence:** HIGH
- **What:** The model table, model filter, model editor, Provider model list, and Provider source column display raw values such as `text2music`, `embedding`, `builtin`, and `custom`.
- **Evidence:** These controls use the enum value directly as the label or rely on a table’s default renderer. The admin locale contains translated column headings but has no keys for model-type or Provider-source enum values.
- **Impact:** zh-CN administrators see English/internal enum identifiers in otherwise translated workflows; `text2music` is particularly implementation-oriented.
- **Fix:** Add and use locale keys with these exact copies: `asr` — en-US “Speech-to-text”, zh-CN “语音转文字”; `chat` — “Chat”, “对话”; `embedding` — “Embeddings”, “向量嵌入”; `image` — “Image generation”, “图像生成”; `realtime` — “Realtime”, “实时交互”; `text2music` — “Music generation”, “音乐生成”; `tts` — “Text-to-speech”, “文字转语音”; `video` — “Video generation”, “视频生成”; `builtin` — “Built-in”, “内置”; `custom` — “Custom”, “自定义”.

### adm-ai-D7-01 — Catalog UI exposes “revision” terminology instead of user-facing version language

- **Severity:** LOW
- **Dimension:** D7 Overly technical / internal-state-leaking UI strings
- **Location:** `src/enterprise/client/features/admin/ai/models/ModelListPage.tsx:175-178`; `src/enterprise/client/features/admin/ai/providers/ProviderListPage.tsx:126-130`; `src/enterprise/client/features/admin/ai/providers/ProviderRevisionsPanel.tsx:95-114`; `locales/en-US/admin.json:235`; `locales/en-US/admin.json:326`; `locales/en-US/admin.json:360`; `locales/en-US/admin.json:377-385`; `locales/zh-CN/admin.json:235`; `locales/zh-CN/admin.json:326`; `locales/zh-CN/admin.json:360`; `locales/zh-CN/admin.json:377-385`
- **Confidence:** HIGH
- **What:** The UI repeatedly exposes the internal “revision” concept, including bare `#<number>` rows and copy describing “immutable catalog revisions.”
- **Evidence:** Both tables label the field “Revision / 修订版本，” the panel is “Revision history / 修订历史，” and rollback text says it creates a new auditable catalog revision.
- **Impact:** Administrators must translate storage/CAS terminology into the product concept they can act on: choosing or restoring a published version.
- **Fix:** Use these exact replacements: column en-US “Published version”, zh-CN “已发布版本”; history title “Version history”, “版本历史”; row label “Version {{revision}}”, “版本 {{revision}}”; description “Previous published versions and rollbacks are kept for auditing.”, “以前发布的版本和回滚记录会保留用于审计。”; rollback description “Restore published version {{revision}}. This creates a new version and keeps the history.”, “恢复已发布版本 {{revision}}。系统会创建一个新版本并保留历史记录。”.

### adm-ai-D8-01 — Provider model reordering has no pending motion and snaps after refresh

- **Severity:** LOW
- **Dimension:** D8 Missing animations / motion
- **Location:** `src/enterprise/client/features/admin/ai/models/ProviderModelsSection.tsx:68-82`; `src/enterprise/client/features/admin/ai/models/ProviderModelsSection.tsx:96-155`; `src/enterprise/client/features/admin/ai/hooks/useAiProviderActions.tsx:636-665`
- **Confidence:** HIGH
- **What:** Move-up/down actions submit a server mutation while the list remains in its old order. The action icons only become disabled; after the refreshed model array arrives, rows instantly jump to their new positions.
- **Evidence:** `ProviderModelsSection` derives `sorted` solely from props and keeps no proposed order. Its rows are plain `<div>` elements without transition or pending indicator. `handleReorderModels` opens the mutation flow and only refreshes after commit.
- **Impact:** There is weak feedback that a potentially slow reorder is in progress, and the eventual layout jump makes it harder to verify which model moved.
- **Fix:** Render the ordered collection with `SortableList` and `SortableList.Item` from `@lobehub/ui`, maintaining a local proposed order until Save completes. Apply `ActionIcon loading={loading}` while pending and use `cssVar.motionDurationFast` with `cssVar.motionEaseInOut` for opacity/background feedback. Use the upstream component’s motion behavior and do not add another animation dependency.

## Dimensions with no findings

None. All eight dimensions had at least one verified fork-owned finding.

## Cross-scope notes

- The actual live Provider Settings implementation remains under `src/routes/(main)/settings/provider/features`, and many files there also differ from upstream. That route tree is outside this assignment but should receive its own audit; the newly added `src/features/SettingsProvider` copy is not currently a substitute for it.
