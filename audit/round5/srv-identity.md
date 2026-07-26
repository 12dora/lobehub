# Round 5 Audit — srv-identity

## Scope

Audited the fork delta under:

- `apps/server/src/enterprise/services/identityProvider`
- `apps/server/src/enterprise/services/secretRewrap`
- `apps/server/src/enterprise/services/adminUser`
- `apps/server/src/enterprise/services/adminUserService.ts`
- `src/libs/better-auth`
- `src/app/spa-auth`

Against baseline `4bab1636408e60a7ee17b640490fbf33a310a325`, the scope contains 99 changed files with 23,334 additions and 134 deletions, a net fork delta of 23,200 lines.

Files and code byte-identical to the baseline were excluded. Unmodified upstream email copy surrounding the fork’s branding substitutions was also excluded. Tests and linters were not executed because relevant suites create database/filesystem state and the charter requires a strictly read-only audit; test sources were inspected statically.

## Summary

| Dimension                                             | Findings | Highest severity |
| ----------------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                        |        1 | MEDIUM           |
| D2 Test decay                                         |        2 | HIGH             |
| D3 Dead code and development debris                   |        2 | LOW              |
| D4 Missing Simplified Chinese i18n coverage           |        0 | —                |
| D5 Potential functional bugs                          |        1 | CRITICAL         |
| D6 Warnings and errors not surfaced via toast         |        0 | —                |
| D7 Overly technical/internal-state-leaking UI strings |        0 | —                |
| D8 Missing animations/motion                          |        0 | —                |

## Findings

### srv-identity-D5-001 — A failed LKG update can resurrect a disabled identity provider during a database outage

- **Severity:** CRITICAL
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/identityProvider/disableService.ts:150-246`; `apps/server/src/enterprise/services/identityProvider/lkg.ts:462-590`; `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:416-525`
- **Confidence:** HIGH
- **What:** Disabling a provider commits its database tombstone before updating the out-of-database last-known-good snapshot. Every LKG failure is treated as best-effort, so the disable operation still succeeds while an older LKG continues to contain the provider. If the database then becomes completely unavailable, startup has no database tombstone to filter that stale LKG and rematerializes the disabled provider.
- **Evidence:** `disableService.ts` commits the disabled draft and tombstone by line 170, then separately calls `advanceIdentityProviderLkgAfterTombstone`. Missing secrets, missing LKG, read/write failures, rejection, and exceptions only populate `lkgAdvance`; line 246 still returns the committed result. The LKG helper explicitly describes itself as “Best-effort” and returns skipped outcomes for `no_lkg`, `read_failed`, and `write_failed`. During startup, `validatedTombstones` starts empty; if `loadPublishedIdentityProviderSelection` fails, lines 432-434 retain that empty list. Lines 502-525 then read and materialize the stale LKG.
- **Impact:** A provider deliberately disabled for compromise, offboarding, or configuration risk can become an active sign-in method again when LKG advancement fails and the database subsequently becomes unavailable. This defeats a security-relevant revocation boundary.
- **Fix:** Introduce a durable, fail-closed revocation journal that startup reads independently of the database and main LKG payload. Record the pending provider denial before acknowledging the disable, commit the database tombstone, then merge/finalize the LKG. Startup must always filter LKG providers through that journal—or reject LKG fallback entirely when the journal cannot be validated. Do not return an ordinary successful disable unless a database-free startup can enforce the revocation.

### srv-identity-D2-001 — The Round-4 outage regression test covers only successful LKG advancement

- **Severity:** HIGH
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/enterprise/services/identityProvider/publicationService.disable.test.ts:232-340`
- **Confidence:** HIGH
- **What:** The regression suite proves that an immediate database outage is safe only when the disable operation successfully rewrites the LKG. It separately tests a missing-secret failure, but checks only the audit row and never exercises startup from the still-stale LKG.
- **Evidence:** Lines 232-299 seed a live LKG, provide valid LKG secrets, disable the provider, simulate total database failure, and assert the provider remains absent. Lines 301-340 remove the required secrets and verify `lkgAdvance` is `skipped`, but stop after checking the failure audit. There is no database-outage startup assertion following the skipped or failed advancement.
- **Impact:** The test named for Round-4 identity/F10 passes while the security invariant fails for every error branch of the best-effort LKG update.
- **Fix:** Add parameterized regression coverage for `missing_secret`, `no_lkg`, `read_failed`, `write_failed`, and rejected advancement. Each case should seed a pre-disable live LKG, perform the disable, make database selection fail completely, and assert that neither `databaseProviders` nor `providerIds` contains the disabled provider. The test should be added alongside the durable revocation fix, because it correctly fails against the current implementation.

### srv-identity-D1-001 — Secret rewrap holds a database transaction across up to 50 sequential Vault operations

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/services/secretRewrap/contracts.ts:11-14`; `apps/server/src/enterprise/services/secretRewrap/worker.ts:44-75`; `apps/server/src/enterprise/services/secretRewrap/worker.ts:236-273`; `apps/server/src/enterprise/services/secretRewrap/worker.ts:450-620`
- **Confidence:** HIGH
- **What:** A rewrap batch opens one transaction, locks the job row with `FOR UPDATE`, and then performs up to 50 sequential remote encryption/rotation calls before checkpointing and committing.
- **Evidence:** The maximum batch size is 50. The transaction begins at line 481 and locks the job row through line 496. Lines 519-546 process every candidate sequentially, while `processCandidate` calls `secrets.rotateToKeyId` before its database CAS. Lines 590-609 perform more potentially remote active-key validation before the transaction commits. The worker comment itself acknowledges that Vault work can exceed the lease while the batch transaction remains open.
- **Impact:** Vault latency or transient stalls keep a database connection, row lock, and transaction snapshot open for the cumulative latency of the batch. This increases pool pressure and PostgreSQL version retention and can block job cancellation, restart, and other job-control updates.
- **Fix:** Perform remote Vault work outside the batch-wide transaction. Use short transactions for claim/checkpoint operations and a short per-candidate transaction for the CAS plus failure-ledger update. Preserve resumability with the existing cursor, revision, and idempotent ledger, and revalidate the active key immediately before each short CAS transaction.

### srv-identity-D3-001 — The flow-only role-mapping migration left an unused subject index and unreachable fallback state

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `apps/server/src/enterprise/services/identityProvider/groupRoleMappingRuntime.ts:1-10`; `apps/server/src/enterprise/services/identityProvider/groupRoleMappingRuntime.ts:15-61`; `apps/server/src/enterprise/services/identityProvider/groupRoleMappingRuntime.ts:80-145`; `apps/server/src/enterprise/services/identityProvider/groupRoleMappingRuntime.ts:205-208`
- **Confidence:** HIGH
- **What:** Round 4 removed subject-based fallback consumption but retained the associated index, synthetic subject-only entries, timestamp, and documentation claiming the fallback still exists.
- **Evidence:** `subjectToFlowIds` is populated and cleaned by `indexFlowUnderSubject`/`unindexFlow`, but `takeIdentityProviderGroupRoleMapping` now returns `null` immediately without a `flowId` and otherwise reads only `pendingByFlowId`. `stashedAt` is stored but no longer participates in selection. The file header still says “Subject-index newest-take is … the fallback when no flow id is available.” Repository search found no consumer outside this file.
- **Impact:** Every pending mapping carries redundant indexing and cleanup work, while flow-less calls create subject-only entries that cannot be reconciled and persist until explicit discard or TTL sweep. The contradictory documentation increases the chance that future authentication changes rely on behavior that no longer exists.
- **Fix:** Make `flowId` required for stashing and remove `subjectToFlowIds`, `stashedAt`, subject-only storage, and their cleanup helpers. If a flow-less path must remain supported, implement a deliberate secure binding step rather than retaining an unreachable fallback. Update the header to describe the flow-only invariant.

### srv-identity-D2-002 — A historical publication-service test is permanently vacuous

- **Severity:** LOW
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/enterprise/services/identityProvider/publicationService.test.ts:1-15`
- **Confidence:** HIGH
- **What:** The retained test file contains only `expect(true).toBe(true)` and can never detect a regression.
- **Evidence:** Lines 12-15 define a test asserting the constant `true`. The comment says the file exists to keep a historical path from returning 404 after the real suites were split, but repository search found no identity-provider reference that needs this path to remain a Vitest test.
- **Impact:** It inflates test counts and reports a passing publication-service suite even if the split suites are accidentally excluded or renamed.
- **Fix:** Remove the vacuous `.test.ts` file and update any external documentation that still points to it. If a machine-readable index is genuinely required, make it a non-test documentation or manifest file validated by the relevant script.

### srv-identity-D3-002 — The admin-user service split left an orphaned method comment

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `apps/server/src/enterprise/services/adminUser/roleService.ts:130-133`; `apps/server/src/enterprise/services/adminUserService.ts:86-102`
- **Confidence:** HIGH
- **What:** `AdminUserRoleService` ends with a documentation comment for recording denied reauthentication, but no declaration follows it. The actual façade method lives in `adminUserService.ts`.
- **Evidence:** After the role mutation method closes, line 132 contains `/** Record denied reauth for high-risk mutations (router-level). */`, followed immediately by the class closing brace. `AdminUserService.recordReauthDenied` is implemented separately at lines 86-102.
- **Impact:** This is visible Round-4 refactor debris and misleadingly suggests that the role service owns an omitted method.
- **Fix:** Remove the orphaned comment or move it onto the actual `recordReauthDenied` façade method.

## Dimensions with no findings

- **D4 Missing Simplified Chinese i18n coverage:** Checked fork-added Better Auth registration outcomes, scoped auth-page metadata, and modified branding seams against the default, en-US, and zh-CN locale mappings. No missing or still-English fork-owned zh-CN key was verified.
- **D6 Warnings and errors not surfaced via toast:** Within the assigned service paths, mutation failures are propagated or returned as structured outcomes, and the LKG partial failure is recorded in the audit log. A downstream loss of that structured outcome is noted below as cross-scope.
- **D7 Overly technical/internal-state-leaking UI strings:** Scoped platform error identifiers are used as internal service/control-flow values; no assigned UI renderer was found presenting them directly to users.
- **D8 Missing animations/motion:** The fork delta in `src/app/spa-auth` is server-rendered auth metadata and template composition, with no interactive loading, list, panel, modal, or state transition requiring motion.

## Cross-scope notes

- `apps/server/src/enterprise/routers/admin/identityProviders.ts:316-323` converts the disable result through `toPublicIdentityProviderDraft`, discarding `lkgAdvance`. The scoped test explicitly acknowledges this. The API/UI owner should expose the partial failure and show an `@lobehub/ui/base-ui` Toast instead of presenting the disable as unqualified success.
- `apps/server/src/enterprise/services/identityProvider/outboundMode.ts:15-22` defaults to `allow-private`, while `packages/locales/src/default/admin.ts:2073-2074` tells users that private and internal issuer addresses are rejected. The identity-provider UI/locales owner should make this copy reflect the effective deployment policy.
