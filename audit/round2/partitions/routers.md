# Partition: routers

## Summary

Authorization and reauthentication are generally disciplined, but two lifecycle paths can leave security-sensitive state misleading or unavailable; registry drift, error misclassification, boundedness, and test-rot issues also remain. `CRITICAL: 0 · HIGH: 2 · MEDIUM: 5 · LOW: 2`.

## Findings

### F1 \[HIGH]\[D5] Disabled connector mode falsely reports successful disconnection

- **Location:** `apps/server/src/enterprise/routers/user/connectors.ts:66`
- **Evidence:** The mutation returns success without invoking revocation when the feature is disabled: `if (!featureEnabled()) return { disconnected: true as const };`. The real service call on line 71 is therefore skipped.
- **Impact / failure scenario:** A user connects an OAuth account, an administrator disables managed connectors, and the user calls `disconnect`. The API reports success while the database binding and secret references remain. Re-enabling the feature can make the supposedly disconnected authorization usable again.
- **Fix:** Never return a fabricated success. Minimally return `FORBIDDEN / PLATFORM_FEATURE_DISABLED`; preferably expose a flag-independent revocation path that removes the binding and revokes its secrets.
- **Confidence:** HIGH

### F2 \[HIGH]\[D5] Generic publish failures can strand all connector runtime access in blocked mode

- **Location:** `apps/server/src/enterprise/routers/admin/managedResources.ts:81`, `apps/server/src/enterprise/routers/admin/managedResources.ts:117`, `apps/server/src/enterprise/routers/admin/managedResources.ts:136`
- **Evidence:** `connectorTransitionCanRestore` starts as `false` and is set to `true` only for `PlatformRevisionConflictError` and `ManagedResourceCatalogNotReadyError`. The `finally` block cancels the acquired transition only when that flag is true: `if (connectorTransitionToken && connectorTransitionCanRestore)`.
- **Impact / failure scenario:** The router begins a transition, which publishes runtime mode `blocked`; then `ManagedResourcePolicyService.publish()` fails before commit with an ordinary database or audit error. The router rethrows without cancelling. The policy remains unchanged, but connector execution remains blocked after the transition lease expires until another capability publication repairs the persistent effective state.
- **Fix:** Track commit stage rather than error class. Set `publishCommitted = true` immediately after `service.publish()` resolves, and cancel any owned transition in `finally` whenever `!publishCommitted`. Preserve blocked mode only for failures occurring after a confirmed commit.
- **Confidence:** HIGH

### F3 \[MEDIUM]\[D5] Identity-provider disable is absent from the mutation policy registry

- **Location:** `apps/server/src/enterprise/routers/admin/identityProviders.ts:235`
- **Evidence:** The live router defines `disable` as a mutation and performs a publication-level state change: `.mutation(...)` with action `admin.identityProviders.disable`. Static reconciliation finds 104 live admin mutations but only 103 mutation-policy entries; the sole missing path is `admin.identityProviders.disable`. Its authorization declaration is present, so the two registries have diverged.
- **Impact / failure scenario:** Policy tooling and control reconciliation omit a dangerous identity-provider shutdown operation. The repository’s exhaustive mutation-registry check fails, and future control audits can incorrectly conclude that every mutation has a declared risk, reauth, audit, and rate-limit policy.
- **Fix:** Register `admin.identityProviders.disable` as a dangerous identity mutation with recent reauth, reason, audit, and shared rate-limit controls; add a regression assertion beside the router tests.
- **Confidence:** HIGH

### F4 \[MEDIUM]\[D1] Full-month statistics perform up to 200 sequential queries and silently truncate

- **Location:** `apps/server/src/enterprise/routers/admin/stats.ts:142`, `apps/server/src/enterprise/routers/admin/stats.ts:150`, `apps/server/src/enterprise/routers/admin/stats.ts:291`
- **Evidence:** `loadAllMonthUsage` serially drains `findByMonthPage` in `for (let page = 0; page < 200; page += 1)` and returns `items` even when the final page still has `nextCursor`. With the model’s 500-row page maximum, the endpoint materializes at most 100,000 records despite comments promising the “full redacted set.”
- **Impact / failure scenario:** A month containing more than 100,000 assistant usage rows is silently undercounted. Large months also hold a huge array in memory and issue as many as 200 sequential database queries in one request.
- **Fix:** Make detailed usage explicitly keyset-paginated and return `{ items, nextCursor }`. Keep daily analytics SQL-aggregated. If compatibility requires the array endpoint temporarily, detect a remaining cursor and return an explicit bounded-result error rather than partial success.
- **Confidence:** HIGH

### F5 \[MEDIUM]\[D5] Unexpected identity-provider failures are mislabeled as invalid client input

- **Location:** `apps/server/src/enterprise/routers/admin/identityProviders.ts:57`, `apps/server/src/enterprise/routers/admin/identityProviders.ts:79`, `apps/server/src/enterprise/routers/admin/identityProviders.ts:106`
- **Evidence:** The shared `execute` wrapper classifies errors by substring checks such as `message.includes('NOT_FOUND')`; every unmatched exception ends as `PLATFORM_INVALID_INPUT`. The catch neither logs nor rethrows unknown errors.
- **Impact / failure scenario:** A database outage, programming error, or unrecognized secret-provider failure during create, publish, disable, or list is returned as a client-validation error. Clients will not retry as an infrastructure failure, and operators receive no router-level diagnostic evidence.
- **Fix:** Map only typed domain errors. Log unknown failures with sanitized class/operation metadata, then return an `INTERNAL_SERVER_ERROR` with a stable enterprise operation-failed code. Remove generic message-substring classification where typed errors exist.
- **Confidence:** HIGH

### F6 \[MEDIUM]\[D1] Credential upload input is unbounded before Base64 decoding

- **Location:** `apps/server/src/enterprise/routers/admin/creds.ts:234`
- **Evidence:** The upload contract accepts `file: z.string()` without a maximum. Downstream code decodes the entire value with `Buffer.from(..., 'base64')` before enforcing the 256 KiB credential-file limit.
- **Impact / failure scenario:** A permitted caller can submit a payload far above the supported file size. The server parses the JSON string and allocates a decoded buffer only to reject it afterward, creating avoidable memory and CPU amplification under concurrent requests.
- **Fix:** Import the canonical byte limit and cap the Base64 string using its encoded-size formula; also validate canonical Base64 at the router boundary. Retain the downstream byte check as defense in depth.
- **Confidence:** MEDIUM

### F7 \[MEDIUM]\[D2] Feature-off connector test locks in the false-success bug

- **Location:** `apps/server/src/enterprise/routers/user/connectors.test.ts:93`, `apps/server/src/enterprise/routers/user/connectors.test.ts:105`
- **Evidence:** The test named “preserves upstream behavior” explicitly expects `disconnect` to resolve as `{ disconnected: true }` while the feature is disabled, without asserting that the service or persistent binding was revoked.
- **Impact / failure scenario:** The test prevents correcting F1 and treats a security-sensitive no-op as intended compatibility behavior.
- **Fix:** **FIX** — expect a stable feature-disabled rejection, or seed a binding and assert that a supported flag-independent disconnect actually revokes it and its secret references.
- **Confidence:** HIGH

### F8 \[LOW]\[D2] Access-status test does not exercise the behavior in its title

- **Location:** `apps/server/src/enterprise/routers/platform.test.ts:58`
- **Evidence:** “getAccessStatus grants authenticated users when platform admin is on” never calls the procedure; it only asserts `typeof createCaller(ctx).getAccessStatus` is `'function'`. The actual behavior is already covered by `accessStatus.test.ts`.
- **Impact / failure scenario:** The test remains green if authentication, middleware, database wiring, or the returned access decision breaks.
- **Fix:** **DELETE** — remove this duplicate non-test, since the dedicated access-status suite exercises the behavior.
- **Confidence:** HIGH

### F9 \[LOW]\[D3] Credential audit-reason constant has an unused public export

- **Location:** `apps/server/src/enterprise/routers/admin/credsSupport.ts:16`, `apps/server/src/enterprise/routers/admin/credsSupport.ts:91`
- **Evidence:** `FIXED_AUDIT_REASON` is used internally by `assertDangerousReauth`, then re-exported. Repository-wide callers do not import that export.
- **Impact / failure scenario:** The router support module exposes an implementation detail as an apparent public contract, encouraging future coupling and unnecessary compatibility maintenance.
- **Fix:** Remove `export { FIXED_AUDIT_REASON };` and keep the constant module-private.
- **Confidence:** HIGH

## Dimension coverage

① Code smells — Found the sequential 100,000-row statistics drain and unbounded credential-upload input; no over-800-line router file, circular dependency, or confirmed resource leak was found.

② Test rot — Found one test that locks in incorrect disconnect behavior and one assertion-free duplicate; no `skip`, `todo`, or `only` tests were present. Add failure-stage coverage for F2 and a pagination-boundary regression for F4.

③ Dead code & dev cruft — Found the unused `FIXED_AUDIT_REASON` export; no committed debug logging, commented-out implementation, cache, or build artifact was found.

④ Missing Simplified-Chinese i18n — Checked router-surfaced error copy against stable enterprise error-code handling and the admin namespace; no confirmed missing or English-only zh-CN string attributable to this partition was found.

⑤ Functional bugs — Issues cluster in connector disable/publish lifecycle handling, identity-provider registry/error mapping, and statistics pagination. The authorization registry otherwise covers all 193 live admin procedures, and the inspected admin mutations carry permission, active-user, rate-limit, and required reauth gates.
