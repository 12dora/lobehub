# Partition: users-rbac

## Summary

The partition’s core authorization, per-role grant preservation, hard-delete cascade, ban enforcement, migration ordering, and locale coverage are generally sound. The principal security weakness is that two database immutability controls trust caller-controlled PostgreSQL settings; the client also has bounded post-commit consistency failures. CRITICAL: 0 · HIGH: 1 · MEDIUM: 2 · LOW: 2.

## Findings

### F1 \[HIGH]\[D5] Caller-controlled GUCs bypass immutable-version and append-only-audit protections

- **Location:** `packages/database/migrations/0140_platform_agent_version_delete_guard.sql:12`, `packages/database/migrations/0145_platform_db_hardening.sql:26`
- **Evidence:** Both trigger functions authorize deletion solely through `current_setting(...)`: `current_setting('lobe.allow_platform_agent_version_delete', true) = 'on'` and `current_setting('lobe.allow_platform_audit_log_delete', true) = 'on'`. Although comments describe these as “transaction-local,” PostgreSQL exposes no locality information through `current_setting`; a caller can issue session-scoped `SET lobe.allow_platform_audit_log_delete = 'on'` with the same result.
- **Impact / failure scenario:** Any compromised connection or SQL-injection path executing under a principal with table-level `DELETE` can enable the setting for its session and delete immutable agent versions or audit evidence outside the intended hard-delete/retention transaction.
- **Fix:** Enforce the escape hatch through database privileges rather than a caller-controlled setting: revoke direct `DELETE` from the application role and expose narrowly scoped `SECURITY DEFINER` deletion routines owned by a separate maintenance role. Make the triggers recognize only that trusted execution role/routine. Add integration tests proving arbitrary `SET` and session-level `set_config(..., false)` cannot authorize deletion.
- **Confidence:** HIGH

### F2 \[MEDIUM]\[D5] One failed cache invalidation prevents all subsequent post-commit refreshes

- **Location:** `src/enterprise/client/features/admin/users/hooks/useAdminUsers.ts:98`, `src/enterprise/client/features/admin/users/hooks/useAdminUsers.ts:123`, `src/enterprise/client/features/admin/users/hooks/useAdminUsers.ts:132`, `src/enterprise/client/features/admin/users/hooks/useAdminUsers.ts:148`, `src/enterprise/client/features/admin/users/hooks/useAdminUsers.ts:157`
- **Evidence:** `softRefresh` wraps an entire task in one `try/catch`. Ban, unban, session revocation, and role replacement then run sequential invalidations: `await refreshAdminUsersList(); await refreshAdminUserDetail(...)`. Rejection of the first call immediately skips the second; the same sequential behavior exists inside detail/audit invalidation.
- **Impact / failure scenario:** A ban, role change, or session revocation commits successfully, but a transient list-refresh failure prevents detail and audit caches from being revalidated. The operator remains on stale security state and may repeat an irreversible action or make another decision using outdated roles, access status, or sessions.
- **Fix:** Execute independent invalidations with `Promise.allSettled`, including list, detail, and audit keys. Warn once when any result rejects, while still attempting every invalidation.
- **Confidence:** HIGH

### F3 \[MEDIUM]\[D5] Background refresh failures silently leave destructive controls operating on stale data

- **Location:** `src/enterprise/client/features/admin/users/UsersListPage.tsx:122`, `src/enterprise/client/features/admin/users/UsersListPage.tsx:344`, `src/enterprise/client/features/admin/users/UserDetailPage.tsx:232`, `src/enterprise/client/features/admin/users/UserDetailPage.tsx:261`, `src/enterprise/client/features/admin/users/tabs/AuditTab.tsx:82`, `src/enterprise/client/features/admin/users/tabs/AuditTab.tsx:93`
- **Evidence:** All three views expose an error only when there is no cached response: `Boolean(error) && !data` or `if (error && !data)`. When SWR retains prior data after a failed revalidation, the list, detail page, and audit tab render that data without any stale/error indication. The detail page continues into its normal action-enabled rendering at line 261.
- **Impact / failure scenario:** Another administrator changes a user’s roles or access status, or a local mutation commits and its revalidation fails. The current administrator sees no warning that the displayed security state is stale and can invoke ban, revoke, role, or delete actions based on obsolete information.
- **Fix:** Render a persistent inline stale-data warning with Retry whenever `error && data`. On the detail page, disable high-risk actions until a successful revalidation or require an explicit refresh before confirmation.
- **Confidence:** HIGH

### F4 \[LOW]\[D1] User mutations erase router-context types through a duplicated reauthentication wrapper

- **Location:** `apps/server/src/enterprise/routers/admin/users.ts:116`, `apps/server/src/enterprise/routers/admin/users.ts:189`, `apps/server/src/enterprise/routers/admin/users.ts:204`, `apps/server/src/enterprise/routers/admin/users.ts:219`, `apps/server/src/enterprise/routers/admin/users.ts:234`, `apps/server/src/enterprise/routers/admin/users.ts:255`, `apps/server/src/enterprise/routers/admin/users.ts:280`
- **Evidence:** The router defines a local, manually shaped `withReauth` context and every dangerous mutation passes its real context using `ctx as never`. This suppresses compile-time checking of authentication fields for all six call sites and duplicates the cross-cutting reauthentication/audit responsibility.
- **Impact / failure scenario:** A router-context or authentication-method change can silently stop supplying a field required by the reauthentication guard; TypeScript cannot detect the drift because every caller is force-cast to `never`.
- **Fix:** Replace the local wrapper with the shared typed dangerous-reauth helper, or derive its context parameter directly from the router context and remove every `as never` cast.
- **Confidence:** HIGH

### F5 \[LOW]\[D2] ADD regression coverage for partial cache-refresh failure

- **Location:** `src/enterprise/client/features/admin/users/hooks/useAdminUsers.softRefresh.test.ts:54`, `src/enterprise/client/features/admin/users/hooks/useAdminUsers.softRefresh.test.ts:57`, `src/enterprise/client/features/admin/users/hooks/useAdminUsers.softRefresh.test.ts:65`
- **Evidence:** The failure test makes every `mutate` call reject via `mutateMock.mockRejectedValue(...)` and asserts only that the committed mutation resolves and a warning appears. It never verifies that detail and audit invalidations are still attempted after the list invalidation rejects.
- **Impact / failure scenario:** The short-circuiting behavior in F2 passes the suite, allowing stale post-commit security data to remain a permanent regression.
- **Fix:** **ADD** a test where the first invalidation rejects and later invalidations succeed; assert that list, detail, and audit cache keys are all attempted and exactly one warning is emitted.
- **Confidence:** HIGH

## Dimension coverage

① Checked router complexity, client hooks, schemas, repositories, and migration helpers for duplication, coupling, resource handling, and query/index problems; the confirmed issue is the type-erasing reauthentication wrapper in F4.

② Checked partition tests for `skip`, `todo`, `only`, weak assertions, shared-state dependence, and missing risky-path regressions; no disabled or assertion-free tests were found, but F5 leaves the partial-refresh failure unprotected.

③ Checked tracked partition files for unused exports, compatibility remnants, commented-out code, debug output, temporary assets, and stale TODO/FIXME markers; no confirmed dead code or committed development cruft was found.

④ Compared user-facing translation references with the `admin` en-US and zh-CN resources; no missing keys, untranslated zh-CN user strings, hardcoded user-facing copy, or namespace mismatches were confirmed.

⑤ Traced user mutations and authorization from UI through router/service/database behavior, including per-role grant preservation, hard-delete cascade, ban enforcement, session-scoped revocation, schema constraints, and migrations 0135–0146. Role preservation, cascade coverage, ban checks, migration ordering, and single-active constraints were sound; issues cluster in the immutability escape hatches and post-commit client consistency described in F1–F3.
