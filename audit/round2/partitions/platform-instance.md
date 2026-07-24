# Partition: platform-instance

## Summary

Permission gates, staged-upload ownership, transactional audit writes, job CAS, and canonical restart convergence are generally sound. The principal risks are stale global-credential updates, incomplete file-secret rotation, and unbounded operational queries. CRITICAL: 0 · HIGH: 3 · MEDIUM: 3 · LOW: 2.

## Findings

### F1 \[HIGH]\[D5] Global credential updates silently overwrite concurrent edits

- **Location:** `apps/server/src/enterprise/routers/admin/creds.ts:203`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:318`, `packages/database/src/models/platform/globalCredential.ts:94`, `packages/database/src/models/platform/globalCredential.ts:301`, `packages/database/src/schemas/platform/credentials.ts:44`
- **Evidence:** The update contract contains only `description`, `id`, `name`, and `values`; it carries no expected revision or timestamp. The model locks the current row with `FOR UPDATE`, but then updates solely with `.where(eq(platformGlobalCredentials.id, params.id))`. The schema has `updatedAt` but no mutation revision. The lock preserves disjoint secret-key merges, but it cannot identify a client that edited a stale snapshot.
- **Impact / failure scenario:** Two administrators open the same credential. Administrator A renames it or rotates key `TOKEN`; administrator B submits an older form for the same field afterward. Both mutations succeed and B silently replaces A's committed change. The audit ledger records two successes rather than a conflict, so the UI falsely indicates that both intentions were preserved.
- **Fix:** Add a numeric revision, or require `expectedUpdatedAt`, in the DTO and router input. Perform the update with `WHERE id = ? AND revision = ?`, increment the revision atomically, and map zero updated rows to the existing revision-conflict error. Add a two-writer regression test proving the stale writer is rejected.
- **Confidence:** HIGH

### F2 \[HIGH]\[D5] File credentials have no in-place secret-rotation path

- **Location:** `apps/server/src/enterprise/routers/admin/creds.ts:203`, `apps/server/src/enterprise/routers/admin/creds.ts:234`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:318`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:346`, `packages/database/src/models/platform/globalCredential.ts:291`
- **Evidence:** `uploadFile` can stage file material, but `update` accepts only `values`. The service explicitly rejects secret updates unless the existing type is KV: `"Values can only be updated for KV credentials"`. Although the model can rotate any supplied envelope by revoking active secrets and inserting the next revision, no file-update API can supply such an envelope or consume a staged replacement.
- **Impact / failure scenario:** When a platform-hosted certificate or service-account file expires or is compromised, an administrator cannot atomically rotate it while retaining the credential key and identity. The only available lifecycle is deletion and recreation, temporarily removing the credential and resetting its revision/audit continuity during a security-sensitive operation.
- **Fix:** Extend file updates with an owner-bound staged upload identifier. Under the same transaction and row lock, consume the staged row for the authenticated actor, revoke the previous envelope, insert the next secret revision, preserve the credential ID/key, and apply the optimistic CAS from F1. Add successful, wrong-owner, expired-stage, rollback, and concurrent-rotation tests.
- **Confidence:** HIGH

### F3 \[HIGH]\[D1] Hardening migration builds large production indexes while blocking writes

- **Location:** `packages/database/migrations/0145_platform_db_hardening.sql:115`, `packages/database/migrations/0145_platform_db_hardening.sql:118`, `packages/database/migrations/0145_platform_db_hardening.sql:121`, `packages/database/migrations/0145_platform_db_hardening.sql:126`
- **Evidence:** Migration 0145 runs ordinary `CREATE INDEX` statements on `topics` and `messages`, plus a GIN title index inside a `DO` block. None use `CONCURRENTLY`. Unlike the new tables in earlier migrations, these are existing high-volume conversation tables.
- **Impact / failure scenario:** Deploying the enterprise migration against a mature installation takes write-blocking locks while PostgreSQL scans the full topics/messages tables. Message creation and updates can stall for the duration of each build, producing an application-wide write outage or request timeouts.
- **Fix:** Move these indexes into a separately staged, non-transactional migration and use `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. Handle the optional `pg_trgm` capability before that phase rather than placing the index build inside a transaction-bound `DO` block.
- **Confidence:** HIGH

### F4 \[MEDIUM]\[D1] System-health polling loads and hashes every catalog payload

- **Location:** `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:37`, `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:61`, `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:115`, `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:145`, `apps/server/src/enterprise/services/platformInstance/domainTargets.ts:98`, `apps/server/src/enterprise/services/platformInstance/domainTargets.ts:159`, `apps/server/src/enterprise/services/platformSystem/adminService.ts:576`, `src/enterprise/client/features/admin/system/hooks/useAdminSystem.ts:37`, `src/enterprise/client/features/admin/system/hooks/useAdminSystem.ts:178`
- **Evidence:** Domain-target resolution calls the full AI and skill snapshot loaders merely to obtain revision tokens. Those loaders select all current rows without pagination, fetch complete revision payloads and skill `content`, `manifest`, and `resources`, then recompute checksums for every entry. `getStatus()` invokes this path, while the system page refreshes its authority on every active-job poll at a three-second interval.
- **Impact / failure scenario:** As the provider/skill catalog grows—or individual skill bundles become large—one administrator viewing active jobs repeatedly transfers and hashes the entire catalog. This creates database bandwidth and CPU load every three seconds and can make the health endpoint itself time out or report the instance subsystem unavailable.
- **Fix:** Add a lightweight, bounded target-token projection that selects only pointer IDs, revisions, stored checksums, status, and secret fingerprints. Persist or incrementally maintain an aggregate catalog token; reserve full-payload validation/materialization for publication and runtime snapshot loading.
- **Confidence:** HIGH

### F5 \[MEDIUM]\[D5] A committed job mutation can remain permanently “unconfirmed”

- **Location:** `src/enterprise/client/features/admin/system/controller.ts:105`, `src/enterprise/client/features/admin/system/hooks/useAdminSystem.ts:265`, `src/enterprise/client/features/admin/system/hooks/useAdminSystem.ts:270`, `src/enterprise/client/features/admin/system/hooks/useAdminSystem.ts:335`
- **Evidence:** After the server returns a committed job, confirmation succeeds only if the job appears in the currently loaded pages with the exact revision and status. On failure, its ID is retained in `refreshPendingRef`. `retryRefresh()` reloads the same loaded page set and removes the entry only if the job is found there; it has no by-ID fallback. Subsequent actions are blocked while that ID remains pending.
- **Impact / failure scenario:** A job near the end of page one is cancelled. Before refresh, a newer job is inserted and pushes it onto page two, which the user has not loaded. The mutation committed, but every refresh omits the job, so the UI continually reports refresh failure and retains the pending warning despite healthy backend state.
- **Fix:** Treat the mutation response as the authoritative CAS result and patch/remove that job in the SWR cache before revalidation. If an independent read is required, add a bounded `getJob(jobId)` endpoint and use it for confirmation rather than requiring membership in loaded list pages. Add a regression test where pagination shifts immediately after commit.
- **Confidence:** HIGH

### F6 \[MEDIUM]\[D1] Usage aggregation can return an unbounded user-dimension result

- **Location:** `packages/database/src/models/platform/globalStats.ts:608`, `packages/database/src/models/platform/globalStats.ts:639`, `packages/database/src/models/platform/globalStats.ts:652`, `packages/database/src/models/platform/globalStats.ts:671`
- **Evidence:** `findAndGroupByDay()` groups by day, model, provider, user ID, and display name, materializes every resulting row into `dimRows`, and then stores all rows in per-day arrays. The comment calls this “bounded by distinct combos,” but no limit or pagination bounds the number of distinct users or combinations.
- **Impact / failure scenario:** A month containing many users and model/provider combinations can yield hundreds of thousands or millions of aggregate rows. The database must sort and return them all, and the Node process retains both `dimRows` and the reconstructed record arrays, causing slow admin statistics requests and potentially excessive memory use.
- **Fix:** Query only the dimensions required by each chart. Keep daily totals bounded, aggregate model/provider categories separately, and page or top-N-cap user-level breakdowns with an explicit “other” bucket. Do not embed all user combinations in every daily response.
- **Confidence:** HIGH

### F7 \[LOW]\[D2] Concurrency regression test depends on a scheduler delay

- **Location:** `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.test.ts:121`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.test.ts:163`, `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.test.ts:168`
- **Evidence:** The test starts the second writer and waits `setTimeout(..., 50)` before releasing the first. The lifecycle barrier proves only that the first writer reached the merge seam; it does not prove that the second writer attempted or blocked on `FOR UPDATE` before release.
- **Impact / failure scenario:** On a slow or heavily loaded runner, the second promise may not reach the database within 50 ms. It then executes after the first commits, and the test passes even if row-lock serialization is later removed—the exact regression this test claims to detect.
- **Fix:** **FIX:** Replace the timer with a deterministic second-writer signal from the database/test seam, then release the first writer only after the second has issued its lock attempt. Alternatively, assert blocking through two explicit transactions and a controlled barrier.
- **Confidence:** HIGH

### F8 \[LOW]\[D2] Migration 0145 is asserted as text but never replayed

- **Location:** `packages/database/src/schemas/platform/credentials.migration.test.ts:79`, `packages/database/src/schemas/platform/credentials.migration.test.ts:133`
- **Evidence:** The hardening test only checks that SQL strings contain selected constraint/index names. The sole replay test applies `foundationSql`—migration 0138—twice; it never executes `hardeningSql` from 0145.
- **Impact / failure scenario:** Invalid ordering, incompatible partial-schema upgrades, trigger defects, non-idempotent statements, or data failures while converting staged-upload IDs can pass the suite as long as the expected text remains present.
- **Fix:** **ADD:** Create a legacy/partially provisioned fixture containing representative staged uploads and referenced upstream tables, apply 0145 twice on a PostgreSQL-compatible integration database, and verify transformed IDs, owner constraints, indexes, triggers, and retained rows. Keep textual assertions only as supplemental checks.
- **Confidence:** HIGH

## Dimension coverage

① Code smells — Checked service size/responsibility boundaries, cleanup paths, catalog/status queries, statistics aggregation, and migration operational cost; confirmed F3, F4, and F6.

② Test rot — Checked partition tests for skipped/only/todo cases, meaningful assertions, timing dependence, and critical regression coverage; confirmed F7 and F8, with missing CAS/file-rotation regressions also called out in F1/F2.

③ Dead code & dev cruft — Checked exports, compatibility helpers, comments, console usage, and temporary artifacts; no confirmed reportable dead code or dev cruft.

④ Missing Simplified-Chinese i18n — Checked system-page translation references and compared all 164 `system.*` entries across en-US and zh-CN; no missing keys, wrong namespace references, untranslated English values, or in-scope hardcoded user-facing strings were confirmed.

⑤ Functional bugs — Traced credential creation/update/staging through router, service, transaction, schema, and audit; traced job CAS/refresh and restart-ledger status convergence. Authorization and canonical pending-restart handling were clean, while F1, F2, and F5 are confirmed correctness gaps.
