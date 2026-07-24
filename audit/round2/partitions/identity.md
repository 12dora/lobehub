# Partition: identity

## Summary

The partition has strong secret projections and publication CAS controls, but revocation convergence and authorization failure handling contain serious fail-open paths. CRITICAL: 3 · HIGH: 4 · MEDIUM: 4 · LOW: 2.

## Findings

### F1 \[CRITICAL]\[D5] Disable commits a tombstone without making runtime reload pending

- **Location:** `apps/server/src/enterprise/services/identityProvider/publicationService.ts:1326`, `apps/server/src/enterprise/services/identityProvider/systemService.ts:205`, `apps/server/src/enterprise/services/identityProvider/systemService.ts:248`, `apps/server/src/enterprise/services/identityProvider/systemService.ts:296`, `apps/server/src/enterprise/services/identityProvider/bootstrap.ts:37`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:108`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:239`
- **Evidence:** Disable persists `activationRevision: null`, `status: 'disabled'`, and `enabled: false`. Runtime status only selects rows where `status = 'pending_restart'`, then derives `pendingRestart` from rows having a non-null activation revision. The bootstrap snapshot is process-cached with `??=`, while the UI refreshes only the provider list after disable and displays Restart only when `runtime.data?.pendingRestart` is true. For an all-provider tombstone, `loadPublishedIdentityTarget` also returns a null target revision, while startup represents the empty provider set with a real identity digest.
- **Impact / failure scenario:** An active provider is compromised and an administrator clicks Disable. The database and audit log say it is disabled, but the running Better Auth configuration remains cached, status says no restart is pending, and the UI offers no restart action. The compromised provider continues accepting logins until an external process restart happens.
- **Fix:** Treat a tombstone as a pending activation: retain its revision, include tombstones in restart status, compute the empty provider-set identity instead of returning null, and reconcile the row to `disabled` only after every fresh instance reports the tombstoned target. Refresh runtime status immediately after the disable mutation.
- **Confidence:** HIGH

### F2 \[CRITICAL]\[D5] Group-to-role reconciliation fails open and preserves revoked privileges

- **Location:** `apps/server/src/enterprise/services/identityProvider/groupRoleMapping.ts:53`, `apps/server/src/enterprise/services/identityProvider/groupRoleMapping.ts:88`, `apps/server/src/enterprise/services/identityProvider/groupRoleMapping.ts:95`, `apps/server/src/enterprise/services/identityProvider/groupRoleMapping.ts:101`, `apps/server/src/enterprise/services/identityProvider/groupRoleMappingRuntime.ts:58`
- **Evidence:** The code explicitly promises that reconciliation is “Non-blocking” so login succeeds. A missing role seed returns `{ skipped: true }`, and every exception from `replaceGlobalUserRoles` is caught and converted to the same successful return. `reconcileIdentityProviderGroupRoles` ignores that result.
- **Impact / failure scenario:** A user previously held `identity_admin`, but the IdP removes the corresponding group. On the next login, a transient database/seed failure prevents replacement with `platform_user`; the exception is swallowed, login succeeds, and the old administrator role remains usable.
- **Fix:** Fail the login/session creation when a configured role mapping cannot be reconciled. Perform role replacement before issuing the session, propagate failures, and add a regression proving that a failed demotion cannot yield an authenticated privileged session.
- **Confidence:** HIGH

### F3 \[CRITICAL]\[D5] One invalid provider causes valid tombstones to be discarded before LKG fallback

- **Location:** `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:133`, `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:197`, `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:234`, `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:383`, `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:446`, `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:453`
- **Evidence:** Selection correctly records tombstones in `tombstoneGenerations`, but `loadDatabasePayload` subsequently throws if any selected live provider lacks a secret. Secret decryption or discovery can also reject the shared `Promise.all`. The outer catch discards the entire candidate—including already-validated tombstones—and loads the previous LKG wholesale.
- **Impact / failure scenario:** LKG contains providers A and B. A is tombstoned after compromise, while B’s latest secret is missing or its discovery endpoint is unavailable. Startup reads A’s valid tombstone, then fails on B and falls back to the old LKG, resurrecting both A and B. A compromised login path becomes active despite a committed revoke.
- **Fix:** Preserve provider IDs and revisions for validated tombstones independently of live-provider materialization. Apply those removals to any LKG fallback even if another provider fails, and isolate validation failures per provider instead of reverting the complete identity set.
- **Confidence:** HIGH

### F4 \[HIGH]\[D5] Admin UI hides revoke for edited providers whose old publication remains live

- **Location:** `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:73`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:293`, `apps/server/src/enterprise/services/identityProvider/publicationService.ts:1246`, `apps/server/src/enterprise/services/identityProvider/publicationService.ts:1272`
- **Evidence:** Both disable guards accept only `active`, `pending_restart`, `published`, or `error`. The backend explicitly supports tombstoning an edited provider whose mutable head is `draft` with `activationRevision=null`, because its older published revision can still be live.
- **Impact / failure scenario:** An administrator edits or clears the secret of an active provider; the head becomes `draft`, but the prior published snapshot remains loaded. If that provider must then be urgently revoked, the UI removes the Disable action and returns early if invoked.
- **Fix:** Expose whether a draft has published history and allow Disable for that state. Keep never-published drafts on the delete path, and add a page-level regression for “publish → edit/clear → revoke.”
- **Confidence:** HIGH

### F5 \[HIGH]\[D5] Successful secret mutations can persist the exact client secret as an audit reason

- **Location:** `apps/server/src/enterprise/routers/admin/identityProviders.ts:114`, `apps/server/src/enterprise/routers/admin/identityProviders.ts:157`, `apps/server/src/enterprise/routers/admin/identityProviders.ts:202`, `apps/server/src/enterprise/routers/admin/identityProviders.ts:371`, `apps/server/src/enterprise/services/identityProvider/adminService.ts:124`, `apps/server/src/enterprise/services/identityProvider/adminService.ts:153`, `apps/server/src/enterprise/services/identityProvider/adminService.ts:168`, `apps/server/src/enterprise/services/identityProvider/adminService.ts:223`
- **Evidence:** `safeIdentityDeniedReason` compares the reason against replacement/current secrets, but it is installed only as `resolveDeniedReason`, which runs after reauthentication fails. With fresh reauthentication, create/update proceeds and `AdminIdentityProviderService` writes `reason: input.reason` verbatim to success or failure audits.
- **Impact / failure scenario:** An administrator pastes an opaque client secret into the reason while replacing that same secret. Pattern-based detection cannot recognize an arbitrary opaque value; fresh reauth succeeds, and the credential is permanently stored in the append-only audit log.
- **Fix:** Validate or redact the reason against replacement and current secret values before every mutation, not only on denied reauth. Pass only the sanitized reason into the service and add success/failure audit regressions using an opaque secret.
- **Confidence:** HIGH

### F6 \[HIGH]\[D5] Auth-setting writes have no CAS and can silently reopen registration

- **Location:** `packages/database/src/schemas/platform/authSettings.ts:10`, `packages/database/src/models/platform/authSettings.ts:42`, `packages/database/src/models/platform/authSettings.ts:57`, `apps/server/src/enterprise/routers/admin/authSettings.ts:40`
- **Evidence:** The singleton schema has no revision field. `update` reads the current document and performs an unconditional full upsert; neither the router input nor the update predicate carries an expected revision.
- **Impact / failure scenario:** Admin A and Admin B load open registration. A closes registration. B, from stale state, changes the domain allowlist and submits the full document with `openRegistration: true`; B’s later upsert silently reopens registration and reports success.
- **Fix:** Add a monotonically increasing revision, return it from `get`, require `expectedRevision` on update, and use a conditional update/upsert that reports a stable conflict. Add a two-writer regression.
- **Confidence:** HIGH

### F7 \[HIGH]\[D5] Enabled email allowlisting accepts an empty list as unrestricted

- **Location:** `packages/database/src/schemas/platform/authSettings.ts:13`, `packages/database/src/models/platform/authSettings.ts:48`
- **Evidence:** The schema allows `emailDomainAllowlistEnabled=true` with `emailDomainAllowlist=[]`, and the model persists that combination without an invariant check. The sign-up matcher treats an empty list as “no restriction,” so enabling the control does not restrict any domain.
- **Impact / failure scenario:** An administrator enables domain allowlisting before entering domains, saves successfully, and leaves open registration on. Every valid email domain can still self-register although the setting is displayed and stored as enabled.
- **Fix:** Reject or fail closed on `emailDomainAllowlistEnabled && emailDomainAllowlist.length === 0`; enforce the invariant in both the model and a database check constraint, with a regression for the empty-list case.
- **Confidence:** HIGH

### F8 \[MEDIUM]\[D5] Providers after page 1 keep a stale revision inside the edit wizard

- **Location:** `src/enterprise/client/features/admin/identityProviders/openIdentityProviderWizardModal.tsx:49`, `src/enterprise/client/features/admin/identityProviders/openIdentityProviderWizardModal.tsx:53`, `src/enterprise/client/features/admin/identityProviders/openIdentityProviderWizardModal.tsx:59`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderWizard.tsx:277`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderWizard.tsx:327`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderWizard.tsx:357`
- **Evidence:** The modal always calls `useIdentityProviders(isEdit)` without the page cursor, so it only searches the first 100 rows and falls back to the original `provider`. `handleSaved` refreshes the originating page cache but retains the modal. Subsequent save/test/publish calls use `provider.revision`.
- **Impact / failure scenario:** Provider 101 is opened from page 2 and saved. The server increments its revision, but the modal still holds the pre-save row because the uncursored list cannot find it. Testing or publishing immediately afterwards sends the stale revision and fails with a conflict.
- **Fix:** Fetch the edited provider by ID or retain the mutation response as the modal’s canonical row. Add a regression using a provider outside the first page.
- **Confidence:** HIGH

### F9 \[MEDIUM]\[D1] Pending group-role mappings form an unbounded process cache

- **Location:** `apps/server/src/enterprise/services/identityProvider/groupRoleMappingRuntime.ts:15`, `apps/server/src/enterprise/services/identityProvider/groupRoleMappingRuntime.ts:28`, `apps/server/src/enterprise/services/identityProvider/groupRoleMappingRuntime.ts:39`
- **Evidence:** `pendingBySubject` is a global `Map`. Entries receive a TTL, but expiration is checked only when the exact provider/subject key is later consumed; there is no sweep, capacity limit, or eviction.
- **Impact / failure scenario:** Login flows that reach profile mapping but fail before session reconciliation leave one entry per unique subject indefinitely. Repeated failed logins across many subjects grow process memory without bound.
- **Fix:** Use a bounded TTL cache with active expiry/eviction, and remove entries on every terminal login failure. Add a test proving expired untouched keys are removed.
- **Confidence:** HIGH

### F10 \[MEDIUM]\[D2] Tombstone outage test primes LKG and misses the dangerous immediate-outage window

- **Location:** `apps/server/src/enterprise/services/identityProvider/publicationService.test.ts:396`, `apps/server/src/enterprise/services/identityProvider/publicationService.test.ts:435`, `apps/server/src/enterprise/services/identityProvider/publicationService.test.ts:440`, `apps/server/src/enterprise/services/identityProvider/publicationService.test.ts:449`
- **Evidence:** Action: **FIX**. The test titled “outage LKG does not resurrect” explicitly performs a successful database startup after disable—“Write tombstone-advanced LKG”—before simulating database failure. It therefore proves only that an already-refreshed LKG stays safe.
- **Impact / failure scenario:** The test remains green while an outage immediately after the disable commit can still load the pre-tombstone LKG. It gives false confidence around the highest-risk revocation interval.
- **Fix:** Add the immediate-outage sequence without the post-disable healthy load, plus a mixed-provider case where another provider fails validation after the tombstone is read.
- **Confidence:** HIGH

### F11 \[MEDIUM]\[D2] Real PostgreSQL secret CAS test is never part of the failure-drill suite

- **Location:** `apps/server/src/enterprise/services/identityProvider/secretStore.pgConcurrency.test.ts:19`, `apps/server/src/enterprise/services/identityProvider/secretStore.pgConcurrency.test.ts:25`
- **Evidence:** Action: **FIX**. The only independent-connection secret CAS test is guarded by `describe.skipIf(TEST_SERVER_DB !== '1')`. The repository’s PostgreSQL failure-drill workflow enumerates identity attempt and convergence suites but not this file, so ordinary runs skip it and the dedicated run does not select it.
- **Impact / failure scenario:** A regression that permits two concurrent secret writers can reach production while both normal CI and the PostgreSQL drill remain green.
- **Fix:** Add this file to the PostgreSQL failure-drill workflow and gate manifest, or merge its assertion into an already mandatory multi-connection suite.
- **Confidence:** HIGH

### F12 \[LOW]\[D4] New disable and restart messages have no admin locale entries

- **Location:** `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:85`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:93`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:115`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:263`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:290`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:308`
- **Evidence:** Eight referenced keys are absent from the default, en-US, and zh-CN admin catalogs: `disable.cancel`, `disable.impact`, `disable.confirm`, `disable.title`, `disable.success`, `restart.failedWithCategory`, `columns.actions`, and `actions.disable`. The component supplies English `defaultValue` strings instead.
- **Impact / failure scenario:** zh-CN administrators see English labels and security-impact text during provider revocation and restart failure handling.
- **Fix:** Add all eight keys to the admin source catalog and hand-written en-US/zh-CN files, then remove the inline English fallbacks.
- **Confidence:** HIGH

### F13 \[LOW]\[D3] Policy-step comment falsely says role-mapping runtime does not exist

- **Location:** `src/enterprise/client/features/admin/identityProviders/steps/PolicyStep.tsx:16`, `apps/server/src/enterprise/services/identityProvider/groupRoleMappingRuntime.ts:47`
- **Evidence:** The UI says group-to-role mapping is omitted “until runtime enforcement exists,” while the same partition contains and calls `reconcileIdentityProviderGroupRoles`.
- **Impact / failure scenario:** Maintainers are directed by a stale architectural premise and may continue suppressing a supported configuration surface or make incorrect security decisions.
- **Fix:** Replace the comment with the actual product constraint, or expose the now-supported mapping editor if omission is no longer intended.
- **Confidence:** HIGH

## Dimension coverage

① Checked service size/responsibility, database query bounds, timers, handles, and caches; the unbounded pending role-mapping cache is the confirmed issue.

② Checked skips/todos, assertion value, concurrency coverage, tombstone/LKG regressions, and page-flow tests; issues cluster in the falsely scoped outage test and an unscheduled PostgreSQL CAS test.

③ Checked unused endpoints/helpers, debug residue, stale comments, compatibility code, and migrations; only the obsolete “runtime enforcement does not exist” comment was confirmed.

④ Compared all static `admin` translation references in the partition with default, en-US, and zh-CN catalogs; eight disable/restart/action keys are missing and fall back to English.

⑤ Traced create/update/test/publish/rollback/disable/restart, startup/LKG, role reconciliation, registration settings, reauth, and pagination end to end; critical issues cluster in revocation convergence, LKG fallback, and fail-open role synchronization.
