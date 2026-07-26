# Verification — adm-ai

## Verdicts

| Finding ID   | Original severity | Verdict    | Corrected severity | One-line reason                                                                                                                                                                                          |
| ------------ | ----------------- | ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| adm-ai-D5-01 | HIGH              | DOWNGRADED | MEDIUM             | Metadata is missing for 24 paths, but transactional server guards reject locked writes and the client rolls them back; the surviving defect is hidden-control exposure and futile locked-write attempts. |
| adm-ai-D5-02 | HIGH              | DOWNGRADED | MEDIUM             | The reachable admin parity editor does send the unsupported `0` sentinel, but validation prevents corruption and the failure affects one option on one editing surface.                                  |

## Details

### adm-ai-D5-01 — DOWNGRADED

- **What the original claimed:** Twenty-four of 28 system-agent policy paths remain editable when hidden or locked, allowing personal values to appear saved despite an effective platform policy.

- **What I actually found:** The registry generates 28 paths—model/provider for 11 agents, plus three `enabled` and three `contextLimit` paths—in `apps/server/src/enterprise/services/settings/registry.ts:511-610`. The user wrapper requests metadata for only four of them in `src/features/ServiceModel/ModelAssignmentsForm.tsx:42-56`. An exact path comparison found the other 24 absent.

  Missing metadata defaults to an empty array in `src/features/ServiceModel/ModelAssignmentsFormView.tsx:175-180`. The ordinary model controls consequently render without policy state at `src/features/ServiceModel/ModelAssignmentsFormView.tsx:224-278`; memory controls ignore metadata entirely at `src/features/ServiceModel/ModelAssignmentsFormView.tsx:280-308`; optional model and enable controls do likewise at `src/features/ServiceModel/ModelAssignmentsFormView.tsx:310-353`.

- **Refutation attempts:**

  - The broad `manage_settings` permission at `src/features/ServiceModel/ModelAssignmentsForm.tsx:22-24` disables the form for unauthorized users, but it is not a path-level policy guard.
  - `usePlatformSettingMeta` correctly fails closed during loading/error and marks locked paths non-writable at `src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.ts:32-44` and `src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.ts:93-100`. That protection applies only when the wrapper actually calls the hook.
  - `ManagedCompositeSettingFieldContent` correctly hides or disables supplied metadata at `src/features/PlatformSettingSourceBadge/ManagedSettingField.tsx:22-27` and `src/features/PlatformSettingSourceBadge/ManagedSettingField.tsx:73-82`. Empty metadata bypasses it.
  - Locked writes are not accepted. The legacy user-settings endpoint delegates to the managed adapter at `apps/server/src/routers/lambda/user.ts:693-708`; that adapter locks the settings bundle, rechecks every published path, and aborts the transaction on `mode === 'locked'` at `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:829-851`.
  - A rejected write rolls back the optimistic client state at `src/store/user/slices/settings/action.ts:202-214`. `useSaveState` records `failed`, not `saved`, at `src/hooks/useSaveState.ts:37-49`, and `AutoSaveHint` renders an error with Retry at `src/components/Editor/AutoSaveHint.tsx:37-47`.
  - Hidden is intentionally presentation-only and writable, as documented in `packages/types/src/platform/settings.ts:4-17` and implemented in `apps/server/src/enterprise/services/settings/effectiveResolver.ts:4-9`. The server test explicitly verifies that a hidden path remains writable at `apps/server/src/enterprise/services/settings/effectiveSettingsService.test.ts:460-465`. Therefore, missing UI metadata genuinely exposes controls that policy says should not be shown.
  - The static coverage test at `src/features/PlatformSettingSourceBadge/controlWiring.test.ts:28-43` requires every registered path literal in its declared surface. The current wrapper lacks 24 such literals, so this test describes the intended guard but does not make the runtime safe.
  - Baseline comparison shows the registry, effective-settings service, and controlled form view are fork additions, while the wrapper was modified. This is not an identical upstream defect.

- **Verdict rationale:** The wiring omission is real, but the reported impact conflates visibility with write authorization. Locked mutations fail transactionally, roll back, and display failed-save state; they do not silently persist or merely lose to the platform value. A visible `default` policy is correctly editable by design. The surviving defect is that hidden controls are exposed and writable, while locked/loading/error controls remain visually enabled and generate failed requests.

- **Corrected severity and scope:** **MEDIUM.** Affects policy presentation and interaction for 24 system-agent paths when hidden, locked, loading, or errored. It does not bypass locked policy enforcement or corrupt managed settings.

### adm-ai-D5-02 — DOWNGRADED

- **What the original claimed:** The shared “Unlimited” value `0` is forwarded to an admin contract accepting only positive integers or `null`; explicit `null` is also lost on single updates.

- **What I actually found:** The reachable `/admin/ai/providers/:id` page deliberately reuses the user provider editor at `src/enterprise/client/features/admin/ai/providerSettings/ProviderSettingsPage.tsx:69-89` and `src/enterprise/client/features/admin/ai/providerSettings/ProviderSettingsPage.tsx:124-135`. Its scoped store injects the admin adapter at `src/enterprise/client/features/admin/ai/providerSettings/AdminProviderSettingsStore.tsx:6-15`.

  That reused form renders `MaxTokenSlider` at `src/routes/(main)/settings/provider/features/ModelList/CreateNewModelModal/Form.tsx:122-128`. The slider labels its minimum “Unlimited” and emits `0` at `src/components/MaxTokenSlider.tsx:35-39` and `src/components/MaxTokenSlider.tsx:67-85`. Create and edit footers submit those form values directly at `src/routes/(main)/settings/provider/features/ModelList/CreateNewModelModal/Footer.tsx:30-44` and `src/routes/(main)/settings/provider/features/ModelList/ModelConfigModal/Footer.tsx:31-40`.

  The adapter preserves zero in create, update, and batch payloads at `src/enterprise/client/services/adminAiInfraAdapter/AdminAiModelService.ts:36-52`, `src/enterprise/client/services/adminAiInfraAdapter/AdminAiModelService.ts:108-125`, and `src/enterprise/client/services/adminAiInfraAdapter/AdminAiModelService.ts:131-155`. Its single-update `?? undefined` also converts explicit `null` to `undefined`.

  The server accepts only positive integers or `null` at `apps/server/src/enterprise/contracts/aiCatalog.ts:544-558` and `apps/server/src/enterprise/contracts/aiCatalog.ts:730-780`. A payload containing zero is therefore rejected before the mutation resolver.

- **Refutation attempts:**

  - The advanced catalog editor rejects non-positive values and maps an empty field to `null` at `src/enterprise/client/features/admin/ai/models/openModelEditorModal.tsx:146-164`. However, it calls `adminAiCatalogService` directly through `src/enterprise/client/features/admin/ai/hooks/useGlobalModelActions.tsx:128-146` and `src/enterprise/client/features/admin/ai/hooks/useGlobalModelActions.tsx:178-196`; it does not guard the reused parity editor.
  - The shared model-bank input permits unrestricted numbers and explicit nullish updates at `packages/model-bank/src/types/aiModel.ts:489-505` and `packages/model-bank/src/types/aiModel.ts:528-542`, confirming that normalization belongs at the adapter/contract boundary.
  - The backend distinguishes `null` from omitted values when merging model patches at `apps/server/src/enterprise/services/aiCatalog/modelBatchDml.ts:219-252`. Converting explicit `null` to `undefined` therefore prevents a supported clear operation.
  - Adapter tests contain only `null` fixture values and omit token values from the create assertion at `src/enterprise/client/services/adminAiInfraAdapter/AdminAiModelService.test.ts:39-99` and `src/enterprise/client/services/adminAiInfraAdapter/AdminAiModelService.test.ts:195-209`; no `0` or explicit-null update case guards this seam.
  - Batch zero handling is defective at the service boundary, but the current admin parity page hides remote-model fetching. The clearly reachable regressions are create and single-model edit; batch impact is programmatic or future-facing.
  - Mapping `0` to `null` is not automatically the correct fix for every provider. The runtime adapter treats a null catalog value as absent and may inherit a built-in model limit at `apps/server/src/enterprise/services/aiCatalog/runtimeAdapter.ts:257-260`. The product must decide whether “Unlimited” means stored zero or unset/inherit.
  - The adapter, admin page, and scoped store are fork additions relative to the supplied baseline. The defect is not out-of-scope upstream behavior.

- **Verdict rationale:** The contract mismatch is independently reproducible and no caller-side guard protects the reused admin provider editor. However, Zod rejects zero before any database mutation, so there is no partial write or data corruption. Positive values work, and the separate advanced editor supports blank/null safely.

- **Corrected severity and scope:** **MEDIUM.** Reachable when an administrator selects “Unlimited” while creating or editing a model on `/admin/ai/providers/:id`; explicit-null clearing is also broken through the adapter interface. Batch impact is presently narrower than reported.
