## Partition: ai

Scope reviewed: `apps/server/src/enterprise/services/aiCatalog` and `src/enterprise/client/features/admin/ai`
Files examined: 81 `.ts`/`.tsx` files, approximately 16,044 lines; notable files include AI catalog administration/publication/runtime services and the admin provider/model/settings/tool parity UI.

### Summary

The catalog has strong fail-closed secret handling, dual-registry coverage, and feature-flag isolation, but five high-risk lifecycle defects remain. The largest risks are publishing credential changes without retesting, treating administratively disabled providers as eligible for BYOK fallback, unsafe hard deletion, dropping OpenAI request-format configuration, and partially applying model batches. Admin parity surfaces also have pagination, RBAC, cache-invalidation, and Chinese-localization gaps. Credential redaction prevents direct leakage, but its substring-based implementation rejects legitimate configurations.

### Findings

#### \[HIGH] Connectivity changes to published providers bypass connection testing

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/aiCatalog/adminService.ts:873`, `apps/server/src/enterprise/services/aiCatalog/publication.ts:137`
- **Problem:** The stale-test bypass is documented for non-secret edits, but `tryPublishImmediate` enables it for every provider with `baseRevision > 0`, including secret rotation, endpoint changes, SDK changes, and check-model changes.
- **Evidence:** `allowStaleConnectionTest: detail.baseRevision > 0` is always passed, while validation accepts a stale test when `allowStaleConnectionTest === true && previouslyPublished`. The existing regression test only changes `displayName`.
- **Impact / failure scenario:** A published provider rotates to an invalid API key or a syntactically valid but unreachable endpoint. `applyImmediate` marks the old test stale, bypasses freshness, and publishes the broken configuration, immediately failing organization-wide requests.
- **Recommendation:** Require a fresh test whenever the secret fingerprint, endpoint, `sdkType`, transport-relevant config, or check model changes. Permit stale reuse only for an explicit allowlist of cosmetic fields. Add invalid-key and unreachable-endpoint regression tests.

#### \[HIGH] Disabled managed providers fail open to user BYOK

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/aiCatalog/runtimeAdapter.ts:367`, `apps/server/src/enterprise/services/aiCatalog/runtimeAdapter.ts:425`
- **Problem:** A known published provider whose current revision is disabled is reported with the same `PLATFORM_NOT_FOUND` error as a provider that has never existed.
- **Evidence:** `if (provider.enabled !== true) throw new AiCatalogNotFoundError();`; `AiCatalogNotFoundError.code` is `PLATFORM_NOT_FOUND`. The verified runtime caller catches that code and invokes the user's BYOK configuration.
- **Impact / failure scenario:** An administrator globally disables provider `openai`, but a user has a personal OpenAI key. The managed lookup returns `PLATFORM_NOT_FOUND`, the runtime falls back to BYOK, and the supposedly disabled provider remains usable.
- **Recommendation:** Distinguish true catalog absence from known-disabled/archived providers. Only true absence should permit BYOK fallback; disabled managed providers should return a fail-closed policy error. Add an end-to-end disabled-provider-with-BYOK regression test.

#### \[HIGH] Provider hard-delete is vulnerable to stale UI and dependency-publication races

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/aiCatalog/adminService.ts:602`, `src/enterprise/client/features/admin/ai/providers/openDeleteProviderModal.tsx:24`, `src/enterprise/client/features/admin/ai/providers/ProviderListPage.tsx:145`
- **Problem:** Hard-delete accepts an optional revision, has no draft-token CAS, and does not acquire the dependency-publication advisory lock. The admin UI sends only `{ id, reason }`.
- **Evidence:** The service checks `expectedRevision` only when supplied, then loops over dependents and deletes all models, revisions, secrets, and the provider. Publication uses `acquirePlatformDependencyPublicationLock`, but hard-delete does not. `buildPayload` omits the list item's available revision.
- **Impact / failure scenario:** Admin A opens revision 3; Admin B publishes revision 4 or edits its draft; Admin A confirms and deletes the newer work. Concurrently, an agent/settings publication can validate the provider while deletion validates no dependents, allowing both transactions to commit and leaving a published dangling reference.
- **Recommendation:** Require both `expectedRevision` and `expectedDraftToken`, pass them from the UI, and acquire the shared dependency-publication lock before checking references or deleting. Resolve all model dependencies in one batched query and add PostgreSQL delete-versus-publication race tests.

#### \[HIGH] Published OpenAI request-format settings are discarded

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/aiCatalog/runtimeAdapter.ts:208`, `apps/server/src/enterprise/services/aiCatalog/connectionTestService.ts:99`, `src/enterprise/client/features/admin/ai/providerSettings/ProviderSettingsPage.tsx:142`
- **Problem:** The Settings parity UI persists provider configuration such as `config.enableResponseApi`, but managed runtime materialization replaces all provider `config` and `settings` with empty objects. Connection testing also ignores that setting and sends no `apiMode`.
- **Evidence:** Every runtime entry is built as `config: {}, settings: {}`. The probe calls `runtime.chat({ ... }, { metadata: ... })` without `apiMode`, despite receiving the full provider record. Verified downstream request construction selects Responses versus Chat Completions from `runtimeConfig[provider].config.enableResponseApi`.
- **Impact / failure scenario:** A custom OpenAI-compatible provider configured for Responses API is materialized without the flag, so clients send Chat Completions and a Responses-only endpoint fails. Conversely, setting `enableResponseApi: false` on built-in OpenAI is lost and clients continue sending Responses requests. The same endpoint may be impossible to publish because its connection test uses the wrong format.
- **Recommendation:** Project a credential-free allowlist of provider config/settings into runtime state, including `enableResponseApi`, while continuing to exclude endpoints and vaults. Pass the corresponding `apiMode` to connection probes and add tests for both explicit `true` and `false`.

#### \[HIGH] Model batch operations can leave partially mutated drafts

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/aiCatalog/adminService.ts:1027`
- **Problem:** `batchToggle`, `batchUpdate`, and `clear` are implemented as loops over public mutation methods, each of which commits its own transaction. The provider is published only after every item succeeds.
- **Evidence:** Each iteration calls `updateModel`, `createModel`, or `deleteModel`, followed by `getDetail`; there is no transaction surrounding the switch or compensating rollback.
- **Impact / failure scenario:** In a ten-model batch, the sixth item fails validation, dependency checks, or CAS. The API rejects the operation, but the first five draft mutations remain committed and unpublished, leaving the catalog in a state the UI did not request.
- **Recommendation:** Execute the complete batch in one transaction using transaction-aware private mutation primitives. Alternatively, explicitly model partial results and recovery, but atomic behavior is preferable. Add a two-item test where the second item fails and assert that the first remains unchanged.

#### \[MEDIUM] Admin skill and connector actions use personal-workspace permissions

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/ai/skills/SkillSettingsPage.tsx:16`, `src/enterprise/client/features/admin/ai/connectors/ConnectorSettingsPage.tsx:16`, `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:80`
- **Problem:** The admin pages inject organization-wide mutation handlers into the personal `ToolSettings` surface without adapting its permission model. The shared controls continue to use personal `create_content` and `edit_own_content` permissions rather than platform `SKILL_*` and `CONNECTOR_*` permissions.
- **Evidence:** Both pages render `<ToolSettings managed={false}>`; the injected scope exposes write callbacks unconditionally and never reads `useAdminAccess`.
- **Impact / failure scenario:** A read-only platform catalog administrator with ordinary personal edit permission sees enabled destructive controls that fail at the server. Conversely, an administrator with the required platform permission but restricted personal-content permission cannot perform an authorized organization-wide action.
- **Recommendation:** Add explicit platform capabilities to `AdminToolScope`, derive them through `useAdminAccess`, and make every shared action use those capabilities whenever an admin scope is present. Preserve server-side authorization as the final enforcement layer.

#### \[MEDIUM] Skill and connector parity views silently truncate larger catalogs

- **Dimension:** 1 / Code smells and performance
- **Location:** `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:85`, `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:124`, `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:139`
- **Problem:** Skills and connectors load only one 100-item page, and connector detail loading silently slices that page to 50.
- **Evidence:** `useFetchAdminSkills({ limit: 100 })`, `adminConnectorsService.list({ limit: 100 })`, and `connectorListItems.slice(0, 50)`. Skipped connectors are not included in `failedIds`, so no partial-load warning is raised.
- **Impact / failure scenario:** An organization with 51 custom connectors sees only 50. With more than 100 skills, later custom skills and builtin overrides disappear, causing administrators to make policy decisions from an incomplete catalog.
- **Recommendation:** Traverse cursors until completion or expose real pagination. Load connector details in bounded chunks and aggregate both failures and omitted IDs. Add 51-connector and 101-skill regression tests.

#### \[MEDIUM] Credential leakage guard rejects benign public data

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/aiCatalog/credentialBoundary.ts:5`, `apps/server/src/enterprise/services/aiCatalog/credentialAdapter.ts:201`, `apps/server/src/enterprise/services/aiCatalog/adminService.ts:292`
- **Problem:** Every string leaf in the credential object—including `authType`, region, username, and one-character values—is treated as secret material and matched as a substring against every public field.
- **Evidence:** `credentialStringLeaves` recursively returns every string; the guard rejects when `credentialLeaves.some((credential) => value.includes(credential))`. The contract permits credential strings with length one and values such as `authType: 'basic'`.
- **Impact / failure scenario:** A ComfyUI credential with `authType: 'basic'` rejects a harmless description containing “basic”. An API key of `"a"` rejects a provider key such as `"alpha"`, making valid test or internally issued credentials impossible to save.
- **Recommendation:** Classify credential fields explicitly. Apply exact/high-entropy matching only to actual secrets, exclude structural values such as `authType`, and validate public URLs separately. Add short-secret and structured-auth false-positive tests while retaining direct-leak tests.

#### \[MEDIUM] Global model mutations leave provider caches stale

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/ai/hooks/useGlobalModelActions.tsx:56`, `src/enterprise/client/features/admin/ai/hooks/useAdminAiCatalog.ts:52`
- **Problem:** Global model mutations refresh only model-list SWR keys even though each mutation also changes the parent provider's models, draft token, and publication status.
- **Evidence:** `commitAndRefresh` uses `refreshAdminAiModelLists`; the available `refreshAdminAiProvider(id)` invalidates provider detail, provider lists, revisions, and model lists but is not used.
- **Impact / failure scenario:** An administrator edits a model from the global model page and returns to an already cached provider detail. It shows the previous models and draft token; the next provider mutation can submit stale CAS data and fail with an avoidable conflict.
- **Recommendation:** Invalidate `refreshAdminAiProvider(model.providerId)` after every committed global model mutation, or centralize catalog mutation invalidation. Add a cross-surface cache regression test.

#### \[MEDIUM] Chinese admin UI exposes English fallback and server messages

- **Dimension:** 4 / Missing simplified-Chinese i18n
- **Location:** `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:236`, `src/enterprise/client/features/admin/ai/providers/ProviderConnectionTestPanel.tsx:37`, `src/enterprise/client/features/admin/ai/shared/AdminDraftPublishBanner.tsx:73`
- **Problem:** A connector error key is absent from both the source locale and `zh-CN`, and raw English server messages are rendered directly in translated UI.
- **Evidence:** `aiToolSettings.connectors.partialLoadFailed` falls back to `` `${count} connectors failed to load...` ``; repository-wide locale lookup found no matching key. Connection results contain English such as `Connection succeeded`, and banners/toasts render `publishError` directly.
- **Impact / failure scenario:** A Chinese administrator encountering a partial connector load, failed first publish, validation error, or connection result sees mixed Chinese and English messaging.
- **Recommendation:** Add the missing key to `packages/locales/src/default/admin.ts` and `locales/zh-CN/admin.json`. Return stable connection/publication issue codes from the service and translate them client-side, preserving only bounded diagnostic metadata as interpolations.

#### \[MEDIUM] Tests enshrine stale behavior and omit critical failure paths

- **Dimension:** 2 / Test rot
- **Location:** `apps/server/src/enterprise/services/aiCatalog/adminService.applyImmediate.test.ts:126`, `apps/server/src/enterprise/services/aiCatalog/runtimeAdapter.test.ts:427`, `apps/server/src/enterprise/services/aiCatalog/publication.pgConcurrency.test.ts:36`
- **Problem:** Existing tests encode the over-broad stale-test bypass and empty runtime config, while destructive deletion, disabled-provider fallback, and multi-item rollback have no regression coverage.
- **Evidence:** One test asserts no retest after a display-name edit without checking secret/endpoint changes; runtime tests explicitly expect `config: {}`; the only PostgreSQL concurrency test is environment-gated and covers publication versus settings, not hard-delete. The only `applyModelImmediate` test covers a single create.
- **Impact / failure scenario:** The current high-risk behaviors can be “protected” as expected behavior, while races and partial-commit failures reach production unnoticed.
- **Recommendation:** Rewrite the stale-test and runtime-config expectations around field sensitivity and safe config projection. Add named tests for `secret rotation requires retest`, `disabled managed provider does not BYOK fallback`, `hard delete serializes with dependency publication`, and `batch failure rolls back prior items`.

#### \[LOW] Two in-scope files exceed the repository size guideline

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/services/aiCatalog/adminService.ts:1`, `apps/server/src/enterprise/services/aiCatalog/runtimeAdapter.test.ts:1`
- **Problem:** `adminService.ts` is 1,138 lines and mixes reads, provider/model mutation, connection testing, dependency deletion, and immediate-publication orchestration. `runtimeAdapter.test.ts` is 873 lines and combines caching, metadata merge, execution, hooks, shadow comparison, and historical revision tests.
- **Evidence:** Both exceed the repository's approximately 800-line code-smell threshold.
- **Impact / failure scenario:** Unrelated lifecycle responsibilities are difficult to review independently, increasing regression risk in already complex transaction and fallback logic.
- **Recommendation:** Split the service into provider, model/batch, deletion, and immediate-publication collaborators. Split runtime tests by materialization/cache, execution allowlists, and exact-revision behavior.

#### \[LOW] Memory settings fetch failures have no recovery path

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/ai/settingsForms/MemorySettingsPage.tsx:30`
- **Problem:** The page reads `mappedError` but discards the underlying `error` and `mutate` retry function. It still renders the form with `isInit=false`.
- **Evidence:** The error alert has no retry action, while the verified shared `MemoryFormView` renders a skeleton whenever `isInit` is false. The adjacent service-model page correctly supplies `initError` and `onRetryInit`.
- **Impact / failure scenario:** A transient settings fetch failure leaves the page on a permanent skeleton. Unmapped errors can produce no visible error at all, and recovery requires a full page reload.
- **Recommendation:** Expose a retry action calling `mutate`, render an explicit error state instead of a loading skeleton, and cover mapped and unmapped fetch failures.

#### \[LOW] `canPublishModel` is unused production state

- **Dimension:** 3 / Dead code and dev cruft
- **Location:** `src/enterprise/client/features/admin/ai/controller.ts:17`
- **Problem:** `AiCatalogPermissions.canPublishModel` is derived but never consumed by production code.
- **Evidence:** Repository-wide search found only the interface declaration, its assignment, and two test fixture literals; no production read exists.
- **Impact / failure scenario:** The field suggests model publication is independently gated when all current model actions actually derive from create/update/delete permissions, misleading future authorization changes.
- **Recommendation:** Remove the field and test fixture entries, or wire it into a real model-publication action if that permission is intentionally required.

### Metrics

- Total findings: 14 (CRITICAL 0, HIGH 5, MEDIUM 6, LOW 3)
- Largest in-scope files (lines): `adminService.ts` 1,138; `runtimeAdapter.test.ts` 873; `useAdminGlobalToolScope.tsx` 731
- Dead-code candidates verified unused repo-wide: 1
