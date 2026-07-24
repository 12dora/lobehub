# Partition: shared-infra

## Summary

The partition is generally fail-closed at enterprise boot, routing, authorization, reauthentication, and server-side concurrency boundaries, but several client-side race and error-classification defects can expose stale state or overwrite recent edits. CRITICAL: 0 · HIGH: 1 · MEDIUM: 5 · LOW: 3

## Findings

### F1 \[HIGH]\[D5] Post-publish refresh can overwrite newer policy edits

- **Location:** `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:175`, `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:321`, `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:398`
- **Evidence:** The publish path calls `setSaveState('saved')` before `await mutate()`, then unconditionally applies the refreshed result with `setDraft(latest.draft)`. Editors become writable while that refresh is pending. The ordinary save path already protects equivalent state updates with `draftEpochRef`, but the publish path does not.
- **Impact / failure scenario:** A publish succeeds, the UI reports “saved,” and the user immediately edits the policy. When the slower refresh completes, its older draft replaces those new local edits without warning.
- **Fix:** Keep editing locked through the refresh or capture the draft epoch before publishing and apply refreshed draft state only if the epoch remains unchanged. Add a regression test that edits during the post-publish refresh.
- **Confidence:** HIGH

### F2 \[MEDIUM]\[D5] Out-of-order access checks can restore stale admin permissions

- **Location:** `src/enterprise/client/providers/AdminAccessProvider.tsx:75`, `src/enterprise/client/providers/AdminAccessProvider.tsx:91`, `src/enterprise/client/providers/AdminAccessProvider.tsx:105`
- **Evidence:** Each `load()` independently awaits `fetcher()` and then calls `setStatus`, `setPermissions`, and `setError`. There is no request generation, abort signal, or “latest request” check; `fetchRef` tracks only the latest fetch function.
- **Impact / failure scenario:** An initial “allowed” request remains in flight while a refresh after permission revocation returns “forbidden.” If the initial request resolves last, it restores the stale allowed status and permissions, remounting protected client UI until a later check. Backend enforcement limits this from becoming a direct authorization bypass, but the shell materially misrepresents current access.
- **Fix:** Increment a request-generation ref for every load and apply results only when the generation is still current and the provider remains mounted/enabled. Invalidate outstanding generations on disable and unmount. Add an out-of-order response test.
- **Confidence:** HIGH

### F3 \[MEDIUM]\[D5] AI infrastructure adapter converts all detail errors into “not configured”

- **Location:** `src/enterprise/client/services/adminAiInfraAdapter/index.ts:108`, `src/enterprise/client/services/adminAiInfraAdapter/AdminAiModelService.ts:65`, `src/enterprise/client/services/adminAiInfraAdapter/shared.ts:93`
- **Evidence:** `getAiProviderById` catches every exception and returns a synthetic disabled built-in provider; model loading similarly catches every `getDetail` failure and returns built-ins only. `createGetOrCreateDetail` also treats every failed lookup as absence and attempts `createAiProvider`.
- **Impact / failure scenario:** Network failures, server errors, feature-disable responses, or permission failures appear as an unconfigured provider instead of an error. A subsequent toggle can attempt to create a provider that already exists, while the UI conceals the actual outage or access problem.
- **Fix:** Apply the fallback/create behavior only when the mapped enterprise error is specifically `PLATFORM_NOT_FOUND`. Rethrow all other failures for normal error handling. Add tests distinguishing not-found, forbidden, network, and server failures.
- **Confidence:** HIGH

### F4 \[MEDIUM]\[D5] Dismissing the unsaved-changes modal can strand navigation

- **Location:** `src/enterprise/client/features/admin/primitives/useUnsavedChangesGuard.ts:86`, `src/enterprise/client/features/admin/primitives/useUnsavedChangesGuard.ts:101`, `src/enterprise/client/features/admin/primitives/useUnsavedChangesGuard.ts:119`
- **Evidence:** The hook notes that `confirmModal` does not report close-icon, Escape, or mask dismissals. Only `onCancel` invokes `blocker.reset()` and only `onOk` invokes `blocker.proceed()`. A passive dismissal therefore resolves neither branch, while the effect depends only on the unchanged blocker state and callbacks.
- **Impact / failure scenario:** With dirty form state, the user attempts navigation and closes the confirmation using Escape, the close icon, or the mask. The router remains blocked; later navigation attempts can appear inert without reopening the decision flow.
- **Fix:** Handle modal open-state changes so every non-confirm dismissal calls the reset/cancel path, or make the modal non-dismissible through every passive mechanism. Add an integration test for close-icon, Escape, and mask dismissal.
- **Confidence:** HIGH

### F5 \[MEDIUM]\[D5] A stale credential reference is treated as an existing vault secret

- **Location:** `src/enterprise/client/hooks/useHeteroAgentCloudConfig.ts:32`, `src/enterprise/client/hooks/useHeteroAgentCloudConfig.ts:47`
- **Evidence:** Readiness is computed as `!!heterogeneousProvider?.env?.CLAUDE_CODE_CRED_KEY || hasCredInVault || isCredsLoading`. The environment value is only a reference to a credential key, but its presence is accepted as proof that the referenced vault entry still exists.
- **Impact / failure scenario:** A user configures the credential and later deletes it from the vault while the agent configuration retains its key reference. The hook continues reporting the cloud agent as configured and enables execution, which then fails when secret resolution occurs.
- **Fix:** After credential loading settles, require the referenced key to exist in the vault. Treat the environment value solely as the lookup key and expose loading/error states separately. Add tests for deleted credentials, stale references, and credential-list failures.
- **Confidence:** HIGH

### F6 \[MEDIUM]\[D5] DataTable row activation also fires for nested controls

- **Location:** `src/enterprise/client/features/admin/primitives/DataTable.tsx:340`, `src/enterprise/client/features/admin/primitives/DataTable.tsx:345`
- **Evidence:** Row props install `onClick: () => onRowActivate(record)` and activate on Enter or Space in `onKeyDown`. Neither handler checks `event.target`, `event.currentTarget`, `defaultPrevented`, or whether the event originated from an interactive descendant.
- **Impact / failure scenario:** Clicking or keyboard-activating a button or link inside a row executes that control and also activates the row. Users can be navigated to a detail view while starting an unrelated download, cancellation, or mutation.
- **Fix:** Ignore events originating from interactive descendants such as buttons, links, inputs, and elements with button/link roles, while preserving activation from the row itself. Add click and keyboard regression tests using a nested button.
- **Confidence:** HIGH

### F7 \[LOW]\[D2] Refresh test validates a local copy instead of production behavior

- **Location:** `src/enterprise/client/features/admin/managedResources/SharedOAuthAuthorizationControl.refresh.test.ts:3`, `src/enterprise/client/features/admin/managedResources/SharedOAuthAuthorizationControl.refresh.test.ts:21`
- **Evidence:** The test defines its own `commitSharedOAuthThenRefresh` helper with the comment that it “mirrors” the control’s try/catch, then tests only that local helper. The production component does not import or execute the tested implementation.
- **Impact / failure scenario:** Production can remove, reorder, or break the commit-versus-refresh error boundary while this test remains green, falsely claiming regression coverage.
- **Fix:** FIX — extract the actual production operation into an imported helper or exercise the component through its mutation path, including a successful commit followed by a rejected refresh.
- **Confidence:** HIGH

### F8 \[LOW]\[D4] OAuth callback result pages bypass zh-CN localization

- **Location:** `src/enterprise/server/connectorOAuthCallback.ts:11`, `src/enterprise/server/connectorOAuthCallback.ts:15`, `src/enterprise/server/identityProviderTestCallback.ts:78`, `src/enterprise/server/identityProviderTestCallback.ts:86`
- **Evidence:** The generated browser pages hardcode English titles and result messages, including `"Connector authorization"`, `"Identity provider test"`, and English success/failure text. They do not select localized strings from request locale information.
- **Impact / failure scenario:** Chinese-language administrators completing connector authorization or identity-provider testing are sent to an English-only terminal page despite the admin console’s zh-CN support.
- **Fix:** Select localized server-rendered strings using the request locale or `Accept-Language`, with explicit en-US and zh-CN variants, while retaining the current HTML escaping and CSP protections.
- **Confidence:** HIGH

### F9 \[LOW]\[D3] Business route configuration retains obsolete commented exports

- **Location:** `packages/business/config/src/server/route.ts:3`
- **Evidence:** The file contains a block of commented-out exports for `TRPC_ASYNC_MAX_DURATION`, `TRPC_TOOLS_MAX_DURATION`, `WEBAPI_CHAT_MAX_DURATION`, and `WEBAPI_PLUGIN_GATEWAY_MAX_DURATION` beneath the active timeout constant.
- **Impact / failure scenario:** The dead configuration suggests unsupported timeout controls still exist and increases the chance that maintainers copy or restore stale values instead of using the current route configuration.
- **Fix:** Delete the commented exports. If any remain required, restore them as documented, tested active configuration rather than commented source.
- **Confidence:** HIGH

## Dimension coverage

① Code smells — Checked providers, hooks, admin primitives, service adapters, runtime configuration, and business packages for excessive coupling, resource leaks, duplication, and unbounded work; no separate confirmed D1 defect was found.

② Test rot — Checked skips, assertions, helper duplication, and critical mutation/race coverage; F7 is a non-production test, and F1–F6 identify specific missing regression cases.

③ Dead code & dev cruft — Checked exports, compatibility shims, logging, TODOs, and business extension scaffolding; only the obsolete commented configuration in F9 was confirmed.

④ Missing Simplified-Chinese i18n — Compared admin en-US and zh-CN key sets and checked literal translation-key references; namespace coverage is complete, but the server-rendered callback pages in F8 bypass localization.

⑤ Functional bugs — Traced enterprise default-off boot, dynamic routes, admin gates, reauthentication, managed-resource publication, SWR refreshes, credential readiness, and service contracts; F1–F6 cluster in client state ordering, error classification, and interaction handling, while examined server authorization, reauthentication, and CAS paths remained fail-closed.
