## Partition: users-rbac

Scope reviewed: `src/enterprise/client/features/admin/users`, `src/enterprise/client/features/admin/managedResources`, and `src/enterprise/client/features/admin/pages`
Files examined: 46 scoped `.ts`/`.tsx` files (6,651 lines), plus matching user/security procedures, contracts, registries, DB models, tests, and admin locales

### Summary

The server-side user procedures are permission-gated and registered in both required security registries; targeted session revoke and single-role revoke correctly support `sessionIds` and `preserveRoleNames`. The largest risks are client-side state handling: managed-resource edits can be lost or stranded, successful mutations can be reported as failures, and destructive modals can disappear while irreversible operations continue. Full role replacement also discards grant metadata and protected roles before constructing its payload. Locale coverage is structurally complete, but the per-user audit view bypasses it and displays internal action IDs plus English system reasons.

### Findings

#### \[HIGH] Full role replacement drops protected roles and grant expiry metadata

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/users/UserDetailPage.tsx:171`; `src/enterprise/client/features/admin/users/modals/actions.tsx:385`; `src/enterprise/client/features/admin/users/modals/actions.tsx:451`
- **Problem:** The detail page passes only role names, discarding each grant’s `expiresAt`. The modal then removes roles that the actor cannot assign and submits all selected roles without `preserveRoleNames`; the shared expiry defaults to absent.
- **Evidence:** `currentRoles: data.roles.map((r) => r.name)`, followed by `currentRoles.filter(...eligible.includes(r))`, then a payload containing only `{ reason, roleNames }`. The server deletes every unpreserved grant and reinserts it with the supplied shared expiry.
- **Impact / failure scenario:** A `user_admin` editing another role on a `super_admin` target silently omits `super_admin`, so the server interprets the request as a forbidden demotion and rejects an action the UI offered. Separately, adding a role to a user whose `auditor` grant expires tomorrow reinserts that unchanged grant with `expiresAt = null`, making temporary access permanent.
- **Recommendation:** Pass complete grant objects into the modal, retain inaccessible current roles in both `roleNames` and `preserveRoleNames`, and preserve unchanged grants. Model expiry per changed/new grant, or require an explicit warning and opt-in before a full replacement widens existing expiry. Add both regression scenarios.

#### \[HIGH] Edits made while managed-resource save is running are silently overwritten

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:141`; `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:191`; `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:288`; `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:214`
- **Problem:** Starting a save changes `saveState` to `saving`, but neither `updateUiMode` nor the resource selects check that state. Success then restores the captured pre-request draft and clears `dirty`.
- **Evidence:** Selects are disabled only by `!canSave || conflict`; `updateUiMode` checks only `canUpdate || conflict`; success executes `setDirty(false)` and rehydrates from the server.
- **Impact / failure scenario:** An admin saves draft D1, changes another resource to create D2 while reauthentication or publishing is pending, and then D1 succeeds. The success path overwrites D2 and removes the unsaved-change guard without warning.
- **Recommendation:** Lock every policy editor control during the save/publish transaction, or version the local draft and clear `dirty` only if it still equals the submitted snapshot. Add a deferred-promise test that edits during save and verifies the later edit survives.

#### \[HIGH] Saved managed-resource drafts can become impossible to publish

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:131`; `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:194`; `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:332`
- **Problem:** Saving and publishing are separate server operations, but hydration always sets `dirty` to false and the only action is disabled when `dirty` is false. The page never compares `data.draft` with `data.published` or uses `data.status`.
- **Evidence:** `setDraft(data.draft); ... setDirty(false)` runs on hydration, while the button uses `disabled={!dirty || ...}`. The existing `resolveManagedResourcePrimaryAction` already models `!dirty && hasChanges → publish`, but production never calls it.
- **Impact / failure scenario:** `saveDraft` commits, then reauthentication is cancelled, the publish request fails, or the tab reloads before publish. On the next load the server returns the changed draft, but the UI says there are no unsaved changes and disables Save, leaving the policy stranded.
- **Recommendation:** Derive `hasChanges` from `draft` versus `published`, expose a publish/retry action for persisted drafts, and display the server status. Wire the existing primary-action state machine or replace it with equivalent production logic, with reload-after-failed-publish coverage.

#### \[HIGH] Post-commit refresh failures are reported as mutation failures

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/users/hooks/useAdminUsers.ts:89`; `src/enterprise/client/features/admin/managedResources/actions.ts:32`; `src/enterprise/client/features/admin/managedResources/SharedOAuthAuthorizationControl.tsx:52`
- **Problem:** Server mutations and subsequent cache/capability refreshes share one rejecting promise. A refresh error therefore propagates as though the mutation itself failed.
- **Evidence:** User actions do `const result = await adminUsersService...; await refresh...; return result`; managed publishing does `const result = await publish(...); await refreshCapabilities(); return result`; shared OAuth similarly awaits `mutate()` before reporting success.
- **Impact / failure scenario:** A hard delete commits but list revalidation fails. The modal displays an error and remains open; retrying now returns not-found even though the deletion succeeded. Likewise, a policy publish can commit and then be shown as failed when capability refresh fails, inviting an unsafe duplicate attempt.
- **Recommendation:** Treat the server response as the commit boundary. Update or invalidate caches separately, and surface refresh failure as “saved, refresh failed” rather than mutation failure. Add tests where the mutation resolves and refresh rejects.

#### \[HIGH] Escape dismisses destructive modals while their mutation continues

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/users/modals/openReasonModal.tsx:245`; `src/enterprise/client/features/admin/users/modals/openReasonModal.tsx:255`; `src/enterprise/client/features/admin/users/modals/CreateUserModal.tsx:169`
- **Problem:** `openReasonModal` uses `maskClosable: false`, but base-ui still commits Escape dismissal. Its `onOpenChange` merely aborts the reauth controller and does not reopen or prevent closing during `mutating`; an already-issued tRPC request has no abort signal.
- **Evidence:** The create-user modal explicitly installs an Escape capture guard because `maskClosable: false` does not block Escape. The generic danger modal has no equivalent phase guard and only calls `abortControllerRef.current?.abort()`.
- **Impact / failure scenario:** After confirming hard delete, an admin presses Escape while the server request is pending. The modal disappears and loses progress/error state, but the deletion continues and may later navigate the page or show a toast.
- **Recommendation:** Prevent framework dismissal while `phase === 'mutating'`, using the proven create-modal guard, or close immediately after confirmation and show durable progress on the originating page. Add a test that models base-ui’s committed Escape close during a pending mutation; current lifecycle tests cover only reauthentication.

#### \[MEDIUM] Nested managed-resource controls use permissions for different procedures

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:249`; `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:301`; `src/enterprise/client/features/admin/managedResources/SharedOAuthAuthorizationControl.tsx:28`; `src/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage.tsx:308`
- **Problem:** Both nested controls inherit `canSave = POLICY_UPDATE && POLICY_PUBLISH`, although their server procedures have independent authorization requirements.
- **Evidence:** `admin.sidebarLayout.update` requires only `POLICY_UPDATE`; `admin.connectors.getGovernance` requires `CONNECTOR_READ`; and `admin.connectors.setSharedAuthorization` requires `CONNECTOR_UPDATE`. The client instead fetches governance whenever the parent renders and disables both controls with `!canSave`.
- **Impact / failure scenario:** A custom role with `POLICY_UPDATE` but no publish permission is server-authorized to update sidebar layout but sees it disabled. A policy editor without `CONNECTOR_UPDATE` sees an enabled shared-OAuth action that the server rejects, while a connector administrator without both policy permissions is incorrectly blocked.
- **Recommendation:** Derive and pass separate `canReadConnectorGovernance`, `canUpdateConnectorGovernance`, and `canUpdateSidebarLayout` flags from the exact permission constants. Gate both SWR keys and controls, and test permission combinations independently.

#### \[MEDIUM] Nested fetch failures render as absent or confidently incorrect state

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/managedResources/SharedOAuthAuthorizationControl.tsx:28`; `src/enterprise/client/features/admin/managedResources/SharedOAuthAuthorizationControl.tsx:71`; `src/enterprise/client/features/admin/managedResources/SidebarLayoutControl.tsx:55`; `src/enterprise/client/features/admin/managedResources/SidebarLayoutControl.tsx:58`
- **Problem:** Neither nested control consumes its SWR `error`. Shared OAuth returns `null` whenever data is absent, while sidebar layout defaults absent data to mode `user` and renders an enabled control whose handlers immediately return.
- **Evidence:** `if (!data) return null` hides all loading/error states; sidebar uses `const mode = data?.mode ?? 'user'` and `if (!data) return` inside its handlers.
- **Impact / failure scenario:** A governance request failure makes a configured shared identity disappear from the page. A sidebar-layout request failure presents “User-customized” as if authoritative, while changing the apparently enabled select does nothing.
- **Recommendation:** Render explicit loading and error states with Retry for each nested request. Never derive a real policy mode from unresolved data, and keep controls disabled until data has successfully loaded.

#### \[MEDIUM] Hard delete lacks an explicit high-friction confirmation gesture

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/users/modals/actions.tsx:507`; `src/enterprise/client/features/admin/users/modals/actions.tsx:514`; `src/enterprise/client/features/admin/users/modals/openReasonModal.tsx:118`
- **Problem:** The irreversible cascade delete uses confirm-only mode with a hidden reason. In that mode the submit button is immediately eligible without typing the target identity, checking an acknowledgement, or otherwise proving intent.
- **Evidence:** `openDeleteUserModal` sets `hideReason: true`; generic eligibility is `(hideReason || reason.trim().length > 0) && phase === 'idle'`.
- **Impact / failure scenario:** A stray click on Delete followed by the prominent confirmation permanently removes the user and every cascaded owned record. The action has no recovery path.
- **Recommendation:** Require typing the target email/name or checking a consequence acknowledgement before enabling confirmation. Keep the target and cascade scope visible and add positive/negative interaction tests.

#### \[MEDIUM] The audit tab bypasses zh-CN action translations and exposes English system reasons

- **Dimension:** 4 / Missing simplified-Chinese (zh-CN) i18n
- **Location:** `src/enterprise/client/features/admin/users/tabs/AuditTab.tsx:93`; `src/enterprise/client/features/admin/users/tabs/AuditTab.tsx:96`; `src/enterprise/client/features/admin/users/modals/actions.tsx:66`; `src/enterprise/client/features/admin/users/modals/CreateUserModal.tsx:84`; `src/enterprise/client/features/admin/managedResources/SharedOAuthAuthorizationControl.tsx:15`
- **Problem:** Audit action IDs and reasons are rendered verbatim. Existing zh-CN action labels are not used, and system-generated reasons are hardcoded English strings stored in the audit trail.
- **Evidence:** The UI renders `{row.action}` and `{row.reason}`. `AUTO_REASON` contains values such as `"Session revoked from admin console"`; locale files contain translations for some `audit.logs.action.admin.users.*` actions but lack new create/delete/revoke-session keys.
- **Impact / failure scenario:** A Chinese administrator sees `admin.users.replaceGlobalRoles` and English reason text inside an otherwise Chinese audit tab. New create and revoke-session events have no localized action label available.
- **Recommendation:** Render actions through `t('audit.logs.action.' + row.action, { defaultValue: row.action })`, add en-US/zh-CN keys for the new actions, and represent automatic reasons as stable machine reason codes localized at render time. Continue rendering genuinely user-entered reasons verbatim.

#### \[MEDIUM] Critical mutation tests omit hard delete and never verify revoke payloads

- **Dimension:** 2 / Test rot
- **Location:** `src/enterprise/client/features/admin/users/adminUsers.service.test.ts:9`; `src/enterprise/client/features/admin/users/adminUsers.service.test.ts:31`; `src/enterprise/client/features/admin/users/UserDetailPage.test.tsx:337`; `src/enterprise/client/features/admin/users/modals/roles.superAdmin.test.tsx:93`
- **Problem:** A test named “wraps all procedures” neither mocks nor calls `admin.users.delete`. The page test stops after asserting arguments passed to a mocked modal, so it never verifies that the real per-role builder emits `preserveRoleNames`, and there is no equivalent targeted-session payload test.
- **Evidence:** The mock lists create/ban/unban/revoke/roles but no `delete`; no `adminUsersService.deleteUser(...)` assertion exists. The per-role test only expects `remainingRoleNames: []`.
- **Impact / failure scenario:** A renamed or disconnected hard-delete client procedure, a missing `sessionIds`, or removal of `preserveRoleNames` can pass the scoped client suite despite breaking the highest-risk operations.
- **Recommendation:** Fix the “all procedures” test to mock/call/assert delete. Add named regressions for `openRevokeSingleSessionModal → sessionIds: [id]`, `openRevokeRoleModal → preserveRoleNames`, protected super-admin replacement, expiry preservation, interrupted managed-resource publish, and edits during save.

#### \[LOW] Managed-resource controller logic and compatibility shims are production-dead

- **Dimension:** 3 / Dead code & dev cruft
- **Location:** `src/enterprise/client/features/admin/managedResources/controller.ts:82`; `src/enterprise/client/features/admin/managedResources/controller.ts:110`; `src/enterprise/client/features/admin/managedResources/controller.ts:171`; `src/enterprise/client/features/admin/managedResources/unsavedNavigationDecision.ts:1`; `src/enterprise/client/features/admin/users/modals/payloadSnapshot.ts:1`; `src/enterprise/client/features/admin/managedResources/hooks/useAdminManagedResources.ts:18`
- **Problem:** The impact-diff, primary-action, and three-way-rebase implementations have no production callers; only `controller.test.ts` imports them. Both one-line compatibility shims are imported only by their own tests, and `refreshAdminManagedResources` is only defined and barrel-exported.
- **Evidence:** Repo-wide `rg` finds `buildManagedResourceDiff`, `resolveManagedResourcePrimaryAction`, and `rebaseManagedResourceDraft` only in `controller.ts` plus `controller.test.ts`; neither shim has a non-test importer.
- **Impact / failure scenario:** Tests validate a staged publish/conflict design that the live page does not use, creating false confidence while the real stranded-draft defect remains uncovered.
- **Recommendation:** Wire the primary-action/rebase logic into the live page where it solves persisted-draft recovery, then remove genuinely unused diff code. Remove the test-only shims and retarget useful tests to their canonical primitive modules.

#### \[LOW] Action modal APIs carry seven unused `userId` parameters

- **Dimension:** 1 / Code smells
- **Location:** `src/enterprise/client/features/admin/users/modals/actions.tsx:131`; `src/enterprise/client/features/admin/users/modals/actions.tsx:199`; `src/enterprise/client/features/admin/users/modals/actions.tsx:248`; `src/enterprise/client/features/admin/users/modals/actions.tsx:297`; `src/enterprise/client/features/admin/users/modals/actions.tsx:377`; `src/enterprise/client/features/admin/users/modals/actions.tsx:476`; `src/enterprise/client/features/admin/users/modals/actions.tsx:508`
- **Problem:** Every opener declares a target `userId`, but none references `params.userId`; target binding is actually performed by outer callback closures.
- **Evidence:** Repo-wide search within `actions.tsx` returns zero `params.userId` references despite seven required properties.
- **Impact / failure scenario:** The API suggests that modal payloads are bound to the supplied target, and tests assert that inert property, obscuring where wrong-target safety actually resides.
- **Recommendation:** Either remove the unused fields and stop testing them, or preferably have each opener build the complete target-bound input so the displayed target and submitted `userId` originate from one immutable snapshot.

#### \[LOW] Users list bypasses the available DatePicker wrapper

- **Dimension:** 1 / Code smells
- **Location:** `src/enterprise/client/features/admin/users/UsersListPage.tsx:5`
- **Problem:** `DatePicker` is imported directly from `antd` even though `@lobehub/ui` exposes the wrapper and the same scoped feature already uses it.
- **Evidence:** `UsersListPage.tsx` imports `{ DatePicker, type TableColumnsType } from 'antd'`; `modals/actions.tsx:3` imports `DatePicker` from `@lobehub/ui`.
- **Impact / failure scenario:** The range picker can drift from the project wrapper’s theming, defaults, and future compatibility behavior.
- **Recommendation:** Import `DatePicker` from `@lobehub/ui` and retain only the type-only table import from `antd`.

### Metrics

- Total findings: 13 (CRITICAL 0, HIGH 5, MEDIUM 5, LOW 3)
- Largest in-scope files (lines): `UsersListPage.test.tsx` 591, `modals/actions.tsx` 530, `modals/CreateUserModal.tsx` 490
- Dead-code candidates verified unused repo-wide: 13 (6 symbols/modules plus 7 unused modal parameters)
