## Partition: platform-instance

Scope reviewed: Backend platformInstance, platformSystem, platformObservability, platformGlobalCredentials, secretRewrap; frontend admin system, overview, stats, and unified directories.
Files examined: 61 `.ts`/`.tsx` files; notable implementations include platform system status, instance convergence, secret-rewrap worker, global credentials, and overview aggregation.

### Summary

The most serious risks are incomplete secret rotation, a lease-expiry livelock in the rewrap worker, lost concurrent credential updates, and an overview query that materializes every monthly assistant message. Restart state is derived independently from the canonical pending-restart ledger, allowing the system page to report “active” incorrectly. Overview and instance pagination also contain avoidable full-table work and inconsistent snapshots. No oversized files, dual-registry omissions, or simplified-Chinese localization gaps were found.

### Findings

#### \[HIGH] Secret rotation omits platform global credentials

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/secretRewrap/contracts.ts:3`, `apps/server/src/enterprise/services/secretRewrap/worker.ts:475`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:448`
- **Problem:** The rewrap contract and worker scan only `PLATFORM_SECRET_ROTATION_DOMAINS`, while platform global credential secrets and staged uploads are separately encrypted by `PlatformSecretService` but never included.
- **Evidence:** The verified domain array contains only `aiCurrent`, `aiImmutable`, `connector`, `identityProvider`, and `identityProviderTestPkce`. Meanwhile `encryptPayload()` and `encryptBytes()` persist envelopes with `keyId`; the credential schema confirms ciphertext/key IDs in both `platform_global_credential_secrets` and `platform_global_credential_uploads`. The primary worker test explicitly expects only five rotated domains.
- **Impact / failure scenario:** A Vault key rotation job can succeed while existing global credentials remain encrypted with the historical key. Retiring that key later makes those credentials unreadable; honoring `historicalKeyRemovalReady=false` instead blocks retirement indefinitely without completing rotation.
- **Recommendation:** Add active global credential envelopes and unexpired staged uploads as rotation domains with exact CAS updates. Add regression test `rewrapsPlatformGlobalCredentialSecretsAndStagedUploads`, verifying decryption before and after rotation and safe historical-key retirement.

#### \[HIGH] Fixed lease can make slow rewrap batches repeat forever

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/secretRewrap/worker.ts:34`, `apps/server/src/enterprise/services/secretRewrap/worker.ts:443`, `apps/server/src/enterprise/services/secretRewrap/worker.ts:481`, `apps/server/src/enterprise/services/secretRewrap/worker.ts:546`
- **Problem:** A worker receives a 60-second lease, then performs the entire batch—including awaited key-provider operations—inside one transaction without extending the lease. The only heartbeat occurs at the final checkpoint.
- **Evidence:** `DEFAULT_LEASE_MS = 60_000`; candidates are processed sequentially with `await processCandidate(...)`; the checkpoint requires `leaseUntil > clock_timestamp()`. A missed checkpoint raises `PlatformSecretRewrapLeaseLostError`, rolls back the transaction, and returns `terminal:false`.
- **Impact / failure scenario:** A cold AppRole Vault path or slow provider taking more than 60 seconds causes all rotations and cursor progress to roll back. The expired job is reclaimed and the same batch repeats, so key rotation never converges.
- **Recommendation:** Heartbeat/extend the lease through a separate connection during work, or move external crypto outside the long transaction and checkpoint with per-row CAS. Add `renewsLeaseDuringSlowVaultBatch`, using a deliberately slow provider whose batch exceeds the lease.

#### \[HIGH] Concurrent partial credential updates silently lose secrets

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:285`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:310`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:318`
- **Problem:** The service reads and decrypts the current KV map before entering the model’s row-locked update transaction. The resulting merged envelope has no expected revision or CAS predicate.
- **Evidence:** `current = await this.readCurrentKvMap(existing.id); merged = { ...current, ...submitted };` is completed before `this.model.update(...)`. Repository verification shows `FOR UPDATE` happens only after this precomputed envelope reaches the model.
- **Impact / failure scenario:** Starting from `{A}`, two administrators concurrently add `{B}` and `{C}`. Both read `{A}`; one writes `{A,B}`, then the other writes `{A,C}`. Both requests succeed and audit success, but `B` is silently lost.
- **Recommendation:** Serialize read/decrypt/merge/write under one transaction or use an expected secret revision with conflict-and-retry semantics. Add a two-connection regression test named `preservesDisjointConcurrentCredentialUpdates`.

#### \[HIGH] Overview trend materializes and returns every monthly assistant message

- **Dimension:** 1 / CODE SMELLS
- **Location:** `src/enterprise/client/features/admin/overview/useOverviewStats.ts:49`, `src/enterprise/client/features/admin/overview/utils.ts:29`
- **Problem:** The overview calls the detailed `usageFindAndGroupByDay` endpoint, although it retains only each day’s `totalTokens`.
- **Evidence:** `toDailyTokenTrend()` maps only `{ day: log.day, tokens: log.totalTokens }`. Backend verification shows the selected endpoint loads every assistant message’s metadata, usage, model, provider, user identity, and returns those records inside daily buckets without pagination.
- **Impact / failure scenario:** On a platform with millions of monthly messages, opening `/admin` causes an unbounded DB result, server-side object aggregation, large serialized payload, browser allocation, and unnecessary exposure of per-user details. The dashboard may time out or exhaust memory.
- **Recommendation:** Add a dedicated SQL `GROUP BY` endpoint returning only bounded `{day,totalTokens}` rows and use it here. Add `overviewUsageTrendUsesAggregatePayload`, asserting the response contains no per-message records.

#### \[MEDIUM] Credential mutations and success audits are not atomic

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:159`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:172`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:318`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:330`
- **Problem:** Credential model mutations commit in their own transactions before the corresponding audit append. Create-file and delete paths follow the same pattern.
- **Evidence:** Representative sequence: `await this.model.create(...)` followed by `await this.audit.append(...)`; update similarly calls `model.update(...)` before `audit.append(...)`. In contrast, the secret-rotation admin service explicitly places both operations in one transaction.
- **Impact / failure scenario:** If the audit insert fails after a credential creation, update, upload, or deletion commits, the API reports failure although state changed and no success audit exists. Retrying can produce conflicts or duplicate user actions.
- **Recommendation:** Wrap each mutation and audit append in one DB transaction, constructing the model and audit service from that transaction. Add `rollsBackCredentialMutationWhenAuditAppendFails` for every mutation family.

#### \[MEDIUM] System restart status ignores the canonical pending-restart ledger

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/platformSystem/adminService.ts:553`, `apps/server/src/enterprise/services/platformSystem/adminService.ts:566`, `apps/server/src/enterprise/services/platformSystem/adminService.ts:572`, `src/enterprise/client/features/admin/system/components/SystemOverview.tsx:148`
- **Problem:** The system page derives `pendingRestart` solely from startup-artifact and target-revision inequality instead of `getAuthSnapshotStatus()`, which owns pending-row reconciliation and blocked restart reasons.
- **Evidence:** The local calculation is `Boolean(artifact && targetRevision && targetRevision !== artifact.identityRevision)`. Canonical service verification queries providers with `status='pending_restart'`, preserves environment-shadowed pending publications, reconciles converged rows, and returns `pendingRestart` plus a restart reason.
- **Impact / failure scenario:** An environment-shadowed provider remains `pending_restart`, while the effective target still matches the startup artifact. Canonical status reports a blocked pending restart, but the system page renders the translated “active” tag. An instance-status query failure also collapses the boolean to false.
- **Recommendation:** Inject or call the canonical authentication snapshot status and expose an explicit unknown state on failure. Add `reportsEnvironmentShadowedPendingRestartFromCanonicalStatus` and a reconciliation regression test.

#### \[MEDIUM] Instance pagination mixes independent convergence snapshots

- **Dimension:** 1 / CODE SMELLS
- **Location:** `apps/server/src/enterprise/services/platformSystem/adminService.ts:467`, `apps/server/src/enterprise/services/platformSystem/adminService.ts:470`, `src/enterprise/client/features/admin/system/hooks/useAdminSystem.ts:74`
- **Problem:** Every instance page concurrently executes a full aggregate `getStatus()` and an independently transacted `getRevisionInventoryPage()`. Later pages recompute summaries that the client discards.
- **Evidence:** `Promise.all([statusService.getStatus(), statusService.getRevisionInventoryPage(...)])` resolves targets twice. The client builds final data from `{ ...pages[0], items }`, retaining only first-page domains while appending rows from later snapshots.
- **Impact / failure scenario:** A catalog publication between the two transactions can return domain headers for revision N and rows evaluated against revision N+1. Loading subsequent pages after another publication further mixes rows evaluated against different targets while repeatedly running aggregate convergence queries.
- **Recommendation:** Resolve targets and page rows from one snapshot, separate summary retrieval from pagination, and bind the pagination cursor to a target revision so target changes invalidate accumulated pages. Add `returnsOneConsistentInstanceSnapshotAcrossPublishRace`.

#### \[MEDIUM] Overview KPI load performs three unused lifetime counts

- **Dimension:** 1 / CODE SMELLS
- **Location:** `src/enterprise/client/features/admin/overview/useOverviewStats.ts:27`
- **Problem:** The KPI hook calls `totals(days)` and three separate date-filtered count endpoints, then discards the lifetime agent, message, and topic counts returned by `totals`.
- **Evidence:** The response uses only `totals.usersActive` and `totals.usersTotal`. Model verification shows `totals` runs two user-count queries plus unfiltered message, topic, and agent counts; the hook then runs those latter three counts again with a date filter—eight table counts across four requests.
- **Impact / failure scenario:** Each dashboard load performs three unnecessary full-table counts on the largest platform tables, increasing latency and database load as messages and topics grow.
- **Recommendation:** Provide one overview aggregate query containing the two user totals and three correctly filtered counts, or expose a user-only totals endpoint. Add `overviewKpisDoNotRequestUnusedLifetimeCounts`.

#### \[MEDIUM] Overview and stats failures become permanent loading skeletons

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `src/enterprise/client/features/admin/overview/KpiRow.tsx:34`, `src/enterprise/client/features/admin/overview/UsageTrendCard.tsx:16`, `src/enterprise/client/features/admin/overview/RankCards.tsx:40`, `src/enterprise/client/features/admin/stats/GlobalStatsPage.tsx:42`
- **Problem:** These components ignore SWR’s `error` and define loading as `isLoading || !data`.
- **Evidence:** After SWR exhausts retries, `data` remains undefined and `isLoading` becomes false, but `!data` keeps the skeleton or chart loading state active indefinitely. No error message or retry action is rendered.
- **Impact / failure scenario:** A permission, network, or server error makes the dashboard appear to be loading forever, concealing both the failure and any recovery path.
- **Recommendation:** Render localized initial-error and stale-data warning states with explicit retry actions, following the system page pattern. Add `rendersRetryableErrorAfterOverviewFetchFailure` for KPI, trend, rankings, and the stats banner.

#### \[LOW] Window-boundary test codifies a 31-day “30-day” range

- **Dimension:** 2 / TEST ROT
- **Location:** `src/enterprise/client/features/admin/overview/utils.ts:16`, `src/enterprise/client/features/admin/overview/utils.test.ts:13`
- **Problem:** The helper subtracts the full `days` value despite documenting an inclusive start, and the test asserts that implementation rather than the user-facing “last N days” semantics.
- **Evidence:** `subtract(days, 'day')` and the test expectation `overviewWindowStartDate(30, 2026-07-22) === '2026-06-22'`.
- **Impact / failure scenario:** An inclusive query on July 22 counts June 22 through July 22—31 calendar dates—while active-user totals use a rolling 30-day timestamp. KPI tiles labeled as one window therefore cover different boundaries.
- **Recommendation:** Use `days - 1` for an inclusive calendar window or rename and align every metric to rolling-duration semantics. Replace the current assertions with `returnsExactlyThirtyCalendarDaysIncludingToday` plus timezone-boundary cases.

#### \[LOW] Invalid base64 file payloads are silently accepted

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:196`
- **Problem:** The validation relies on `Buffer.from(value, 'base64')` throwing, but Node’s decoder ignores invalid characters.
- **Evidence:** `Buffer.from('YWJj!!!!', 'base64')` successfully produces `abc`; therefore the catch block does not reject the malformed payload. Another enterprise asset validator already uses an alphabet check and canonical round trip.
- **Impact / failure scenario:** A corrupted or nonconforming client payload is stored as silently altered credential bytes under a hash the caller did not intend.
- **Recommendation:** Require the canonical base64 alphabet/padding and verify `bytes.toString('base64') === input`. Add `rejectsNonCanonicalBase64Uploads`.

#### \[LOW] Jobs SWR-key builder is production-dead but test-maintained

- **Dimension:** 3 / DEAD CODE & DEV CRUFT
- **Location:** `src/enterprise/client/features/admin/system/swrKeys.ts:19`, `src/enterprise/client/features/admin/system/hooks/useAdminSystem.ts:140`, `src/enterprise/client/features/admin/system/swrKeys.test.ts:16`
- **Problem:** `buildAdminSystemJobsKey` is exported and directly tested but never called by production code.
- **Evidence:** Repo-wide search finds only its declaration and two test references; `useAdminSystemJobs` reconstructs `[ADMIN_SYSTEM_JOBS_KEY, { cursor, limit }]` inline.
- **Impact / failure scenario:** The duplicate key construction can drift while its isolated test still passes, creating misleading coverage and unnecessary public API surface.
- **Recommendation:** Use the builder in `useAdminSystemJobs`, or delete the builder and its assertions if direct construction is preferred.

Dimension 4: no significant findings. All 90 statically referenced admin keys exist in the default, en-US, and zh-CN catalogs with matching interpolation variables; no hardcoded user-facing TSX copy was found.

### Metrics

- Total findings: 12 (CRITICAL 0, HIGH 4, MEDIUM 5, LOW 3)
- Largest in-scope files (lines): `platformSystem/adminService.ts` 653; `secretRewrap/worker.ts` 598; `secretRewrap/worker.test.ts` 499
- Dead-code candidates verified unused repo-wide: 1
