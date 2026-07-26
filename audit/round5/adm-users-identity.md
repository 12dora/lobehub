# Round 5 Audit — adm-users-identity

## Scope

Audited all fork-owned changes under:

- `src/enterprise/client/features/admin/users`
- `src/enterprise/client/features/admin/identityProviders`
- `src/enterprise/client/features/admin/securityAuth`
- `src/enterprise/client/features/admin/reauth`
- `src/enterprise/client/features/admin/gates`
- The five assigned admin service files
- `src/features/Auth`
- `src/features/AuthShell`

The baseline-to-HEAD delta contains 87 touched files, with 12,737 added and 49 removed lines. The touched files contain 14,453 current lines in total.

Byte-identical upstream files and untouched upstream hunks were excluded. Of the listed Round-4 remediation commits, only `d84ca6758a` touched this scope; its affected call sites and tests were reviewed as prime suspects. This was a static, read-only audit; no tests, formatters, or write-capable checks were run.

## Summary

| Dimension                                             | Findings | Highest severity |
| ----------------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                        |        1 | LOW              |
| D2 Test decay                                         |        1 | MEDIUM           |
| D3 Dead code and development debris                   |        1 | LOW              |
| D4 Missing Simplified Chinese i18n coverage           |        1 | LOW              |
| D5 Potential functional bugs                          |        3 | MEDIUM           |
| D6 Warnings and errors not surfaced via toast         |        1 | LOW              |
| D7 Overly technical/internal-state-leaking UI strings |        1 | LOW              |
| D8 Missing animations/motion                          |        1 | LOW              |

## Findings

### adm-users-identity-D5-1 — Date pickers reject valid expirations later today

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/enterprise/client/features/admin/users/modals/actions.tsx:105-113`, `src/enterprise/client/features/admin/users/modals/actions.tsx:356-369`
- **Confidence:** HIGH
- **What:** Both the temporary-ban and temporary-role expiry pickers disable the whole current day, even though a future time later today is valid.
- **Evidence:** Both pickers use `disabledDate={(d) => d.isBefore(dayjs())}` alongside `showTime`. A date-picker cell representing today starts at midnight, which is before the current instant, so today is disabled. The later form validation already performs the correct precise check with `isAfter(dayjs())`.
- **Impact:** Administrators cannot create a ban or role assignment that expires later on the same day. This removes valid short-lived access-control options from a normal workflow.
- **Fix:** Compare calendar days in `disabledDate`, for example `d.isBefore(dayjs(), 'day')`, while retaining the exact-time validation to reject already-past times.

### adm-users-identity-D5-2 — Escape silently destroys a populated create-user draft

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/enterprise/client/features/admin/users/CreateUserModal.tsx:128-136`, `src/enterprise/client/features/admin/users/CreateUserModal.tsx:166-181`, `src/enterprise/client/features/admin/users/CreateUserModal.tsx:456-494`
- **Confidence:** HIGH
- **What:** The modal protects Escape dismissal only while a mutation is running or after success. During the normal editing phase, Escape closes the modal even when fields or a generated password contain unsaved work.
- **Evidence:** The capture-phase Escape handler prevents dismissal only for `mutating` and `success`. `onOpenChange` applies the same phase-only rule and otherwise aborts and closes. It does not inspect whether email, name, username, roles, or credentials have become dirty.
- **Impact:** An accidental Escape can erase the entire user draft and a newly generated password without confirmation. The password may not be reproducible after reopening.
- **Fix:** Track dirty state independently of mutation phase. When Escape attempts to close a dirty draft, use `confirmModal` from `@lobehub/ui/base-ui` to offer “Continue editing” and an explicit destructive “Discard draft.” Pristine drafts may continue to close immediately.

### adm-users-identity-D2-1 — Dismissal tests cover only pristine drafts and miss the data-loss path

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/enterprise/client/features/admin/users/CreateUserModal.dismissGuard.test.tsx:206-216`, `src/enterprise/client/features/admin/users/CreateUserModal.test.tsx:180-227`
- **Confidence:** HIGH
- **What:** The Escape tests assert that an idle modal closes, but they never populate the form before dismissal. Consequently, the suite defines “safe to dismiss” only by request phase and cannot detect loss of an edited draft.
- **Evidence:** The dismissal-guard test invokes Escape while the modal is pristine. The main modal test likewise exercises Escape before `fillValidForm`; no test types user data, generates a password, and then attempts dismissal.
- **Impact:** The user-data-loss behavior in D5-2 passes the current suite and can regress repeatedly.
- **Fix:** Add coverage for a populated, idle draft: fill all relevant fields, generate or enter a password, simulate the base-ui Escape dismissal path, and verify the modal remains open with values intact until an explicit discard is confirmed. Retain a separate test proving that a pristine draft closes normally.

### adm-users-identity-D5-3 — Concurrent restarts can display another request’s failure category

- **Severity:** LOW
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/enterprise/client/features/admin/identityProviders/restart/controller.ts:295-303`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:370-376`
- **Confidence:** HIGH
- **What:** Restart polling identifies the current attempt by request ID, but the failure banner displays the category from the singular newest restart request instead of the matching attempt.
- **Evidence:** The controller searches `restartRequests` for `attempt.requestId`. The page later interpolates `runtime.data?.restartRequest?.resultCategory`, where `restartRequest` is the newest request. If another administrator starts a later restart, these can refer to different operations.
- **Impact:** The page can show the wrong diagnostic category—or no category—for the restart the current administrator initiated, leading to inappropriate troubleshooting or retries.
- **Fix:** Resolve the result from `restartRequests.find(({ requestId }) => requestId === restartLifecycle.attempt?.requestId)` and expose that matched result through the lifecycle hook. Use the singular field only when its ID matches.

### adm-users-identity-D1-1 — Identity-provider deletion bypasses the domain service boundary

- **Severity:** LOW
- **Dimension:** D1 Code smells
- **Location:** `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:13-14`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:151-157`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:211-217`, `src/enterprise/client/services/adminIdentityProviders.ts:12-46`
- **Confidence:** HIGH
- **What:** The page uses `adminIdentityProvidersService` for other provider operations but imports `lambdaClient` and calls the delete procedure directly.
- **Evidence:** Disable is routed through the service, while delete calls the transport from the component. A scoped repository search found no other production feature importing `lambdaClient` directly for this domain, and the service lacks a delete method.
- **Impact:** Transport details leak into presentation code, deletion lacks the same adapter/test boundary as related operations, and future contract changes can leave this one workflow half-migrated.
- **Fix:** Add a typed delete method to `adminIdentityProvidersService`, route the page through it, and cover the adapter in the service test.

### adm-users-identity-D3-1 — Round-4 cleanup left three unused identity-provider client methods

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `src/enterprise/client/services/adminIdentityProviders.ts:22-23`, `src/enterprise/client/services/adminIdentityProviders.ts:26-32`, `src/enterprise/client/services/adminIdentityProviders.ts:39-40`, `src/enterprise/client/features/admin/identityProviders/steps/PublishStep.tsx:27-31`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderWizard.tsx:340-341`
- **Confidence:** HIGH
- **What:** `listPublishedRevisions`, `rollback`, and `validateNetwork` remain exported even though their UI workflows were removed or intentionally bypassed.
- **Evidence:** `PublishStep` states that rollback and revision selection were removed. The wizard states discovery must not invoke `validateNetwork`. A repository-wide production-code search found no callers of these three service methods; remaining references are test mocks or “not called” assertions.
- **Impact:** The service advertises unsupported workflows, preserves misleading mocks, and increases the chance that new code accidentally revives obsolete behavior.
- **Fix:** Remove the unused client wrappers and stale mocks. Keep server procedures only where external compatibility still requires them.

### adm-users-identity-D4-1 — “Client ID” remains untranslated in Simplified Chinese

- **Severity:** LOW
- **Dimension:** D4 Missing Simplified Chinese i18n coverage
- **Location:** `src/enterprise/client/features/admin/identityProviders/steps/ClientStep.tsx:41-43`, `packages/locales/src/default/admin.ts:2080`, `locales/en-US/admin.json:1424`, `locales/zh-CN/admin.json:1424`
- **Confidence:** HIGH
- **What:** The UI correctly calls the locale key, but the zh-CN value is still the English text `Client ID`.
- **Evidence:** `ClientStep` renders `t('identityProviders.fields.clientId')`. The source, en-US, and zh-CN resources all resolve that key to `Client ID`.
- **Impact:** A core field in the Chinese identity-provider setup flow appears untranslated.
- **Fix:** Use the following localized copy:
  - **en-US:** `Client ID`
  - **zh-CN:** `客户端 ID`

### adm-users-identity-D6-1 — Cancelling reauthentication is reported as an operation failure

- **Severity:** LOW
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `src/enterprise/client/features/admin/reauth/requestAdminReauth.ts:23-28`, `src/enterprise/client/features/admin/reauth/requestAdminReauth.ts:177-180`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:140-186`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:203-227`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:241-283`
- **Confidence:** HIGH
- **What:** Closing the reauthentication popup produces `AdminReauthCancelledError`, but disable, delete, and restart catch every error and show a failure toast.
- **Evidence:** The reauthentication helper explicitly rejects with its cancellation error when the popup closes. All three page handlers route that rejection to generic `toast.error` or `reauthFailed` messaging without distinguishing cancellation. The repository’s shared reauth mutation helper already treats this error as benign.
- **Impact:** Choosing to cancel a sensitive action produces a noisy, misleading failure notification even though the system behaved correctly.
- **Fix:** Detect `AdminReauthCancelledError` and return without a toast. Continue using `Toast`/`toast.error` from the existing UI library for popup-blocked, timeout, authorization, and actual mutation failures.

### adm-users-identity-D7-1 — Restart and disable messages expose lifecycle internals and raw scheduler enums

- **Severity:** LOW
- **Dimension:** D7 Overly technical/internal-state-leaking UI strings
- **Location:** `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:129-150`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:370-375`, `packages/locales/src/default/admin.ts:2119`, `locales/en-US/admin.json:1449`, `locales/zh-CN/admin.json:1449`
- **Confidence:** HIGH
- **What:** The UI discusses “signed tombstone revision,” instance reloads, and republishing configuration, and directly interpolates internal result categories such as `signal_schedule_failed`.
- **Evidence:** The disable-impact fallback contains deployment terminology rather than user actions. The failure banner renders `Restart failed ({{category}})`, and the server emits underscore-delimited scheduler categories.
- **Impact:** Administrators see implementation details they cannot act on, while the actionable cause and next step remain unclear.
- **Fix:** Map internal categories to localized, actionable messages and never interpolate raw enum values. Suggested copy:
  - **Disable impact, en-US:** `This sign-in method will stop accepting new logins after the service restarts. To use it again, create and publish a new configuration.`
  - **Disable impact, zh-CN:** `服务重启后，此登录方式将停止接受新的登录。若要重新启用，请创建并发布新的配置。`
  - **Scheduling failure, en-US:** `The restart could not be scheduled. Check the restart configuration and try again.`
  - **Scheduling failure, zh-CN:** `无法安排重启。请检查重启配置后再试。`

### adm-users-identity-D8-1 — Two-minute restart polling has no visible motion or progress indicator

- **Severity:** LOW
- **Dimension:** D8 Missing animations/motion
- **Location:** `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:357-358`, `src/enterprise/client/features/admin/identityProviders/restart/controller.ts:213`, `src/enterprise/client/features/admin/identityProviders/restart/useIdentityProviderRestartLifecycle.ts:94-99`
- **Confidence:** HIGH
- **What:** Once a restart is accepted, the UI presents only a static `Alert` while polling can continue for up to 120 seconds.
- **Evidence:** The accepted phase renders a text alert, the controller defines a 120,000 ms timeout, and the lifecycle hook continues timer-driven polling without a spinner or other changing status.
- **Impact:** During a slow restart, the page can look stalled, weakening certainty about whether monitoring is still active.
- **Fix:** Add `NeuralNetworkLoading` from `@lobehub/ui`, for example with `size={16}`, to the accepted-phase `Alert` action or description. Use `createStaticStyles` with a `prefers-reduced-motion: reduce` fallback to a static status icon; do not add an animation dependency.

## Dimensions with no findings

None. Each of D1 through D8 produced at least one verified finding.

## Cross-scope notes

- `packages/types/src/platform/identityProvider.ts:91` defines the default login-button label as the hardcoded Chinese string `使用工作账号登录`. The scoped wizard consumes that platform default, so the owning types/localization auditor should determine whether it must become locale-neutral.
- Round-4 removed the rollback UI, but rollback-related entries remain in the out-of-scope admin locale resources. Their broader callers should be checked before those keys are retired.
