# Partition: db-core

## Summary

The core transaction and immutability design is generally sound, but job retry enforcement has a confirmed crash-recovery hole. Migration locking and several unenforced schema invariants also need hardening. CRITICAL: 0 · HIGH: 1 · MEDIUM: 2 · LOW: 3.

## Findings

### F1 \[HIGH]\[D5] Crashed jobs can exceed `maxAttempts` and repeat side effects

- **Location:** `packages/database/src/models/platform/job.ts:335`, `packages/database/src/models/platform/job.ts:361`, `packages/database/src/models/platform/job.ts:455`, `packages/database/src/schemas/platform/jobs.ts:62`
- **Evidence:** Claim eligibility is only `status = 'pending'` or expired `status = 'running'`; it never checks `max_attempts`. The selected row is then unconditionally advanced with `const nextAttempt = candidate.attempt + 1`. `maxAttempts` is consulted only by `fail()`: `${platformJobs.attempt} >= ${platformJobs.maxAttempts}`.
- **Impact / failure scenario:** A job with `maxAttempts = 1` is claimed, performs some external or destructive work, and crashes before `fail()` or `complete()`. After lease expiry, `claimNext()` claims it again with attempt 2, bypassing the configured execution limit and potentially repeating side effects.
- **Fix:** In the claim transaction, exclude rows where `maxAttempts IS NOT NULL AND attempt >= maxAttempts`; transition exhausted expired jobs to `dead` rather than stranding them. ADD a regression test covering crash plus lease expiry at the attempt limit.
- **Confidence:** HIGH

### F2 \[MEDIUM]\[D1] Migrations build blocking indexes on existing high-write tables

- **Location:** `packages/database/migrations/0141_platform_audit_admin_foundation.sql:119`, `packages/database/migrations/0145_platform_db_hardening.sql:115`, `packages/database/migrations/0145_platform_db_hardening.sql:118`, `packages/database/migrations/0145_platform_db_hardening.sql:121`
- **Evidence:** The migrations execute ordinary statements such as `CREATE INDEX IF NOT EXISTS ... ON "platform_audit_logs"`, `... ON "topics"`, and two indexes on `"messages"` without `CONCURRENTLY`.
- **Impact / failure scenario:** On an established installation with large message/topic/audit tables, each index build takes a lock that blocks writes for the duration. Migration deployment can therefore halt message creation and audit logging while several full-table index builds run sequentially.
- **Fix:** Build these indexes with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` through a migration path that does not wrap them in a transaction. If these migrations are already released, add a deployment-safe follow-up rather than rewriting production history.
- **Confidence:** HIGH

### F3 \[MEDIUM]\[D5] Declared singleton policy tables permit arbitrary row identities

- **Location:** `packages/database/src/schemas/platform/authSettings.ts:5`, `packages/database/src/schemas/platform/authSettings.ts:11`, `packages/database/src/schemas/platform/sidebarLayout.ts:7`, `packages/database/src/schemas/platform/sidebarLayout.ts:13`, `packages/database/migrations/0142_platform_auth_settings.sql:7`, `packages/database/migrations/0143_platform_sidebar_layout.sql:7`
- **Evidence:** Both schemas state that `id` is always `'global'`, but physically define only `id: text('id').primaryKey().notNull()`. The migrations likewise create unrestricted text primary keys with no `CHECK ("id" = 'global')`.
- **Impact / failure scenario:** A seed, repair, or secondary writer using `glboal` or another ID succeeds. Runtime readers query only `id = 'global'`, silently ignore the stored policy, and fall back to defaults—open registration for auth settings and user-controlled sidebar layout.
- **Fix:** Add `CHECK (id = 'global')` to both schemas and a guarded follow-up migration. Before validation, explicitly reject or quarantine unexpected existing rows rather than silently choosing one.
- **Confidence:** HIGH

### F4 \[LOW]\[D5] Sidebar policy mode is not constrained at the database boundary

- **Location:** `packages/database/src/schemas/platform/sidebarLayout.ts:16`, `packages/database/src/models/platform/sidebarLayout.ts:37`, `packages/database/migrations/0143_platform_sidebar_layout.sql:9`
- **Evidence:** `mode` is unrestricted `text DEFAULT 'user' NOT NULL`. The reader converts every value other than exact `'platform'` to `'user'`: `(row.mode as SidebarLayoutMode) === 'platform' ? 'platform' : 'user'`.
- **Impact / failure scenario:** A malformed value such as `platfrom` is accepted and subsequently interpreted as user-managed mode, silently disabling the centrally managed layout rather than exposing the corrupt policy.
- **Fix:** Add a schema and migration constraint `CHECK (mode IN ('user', 'platform'))`, including a deterministic repair for pre-existing invalid values.
- **Confidence:** HIGH

### F5 \[LOW]\[D2] The canonical checksum helper lacks independent regression vectors

- **Location:** `packages/database/src/models/platform/checksum.ts:7`, `packages/database/src/models/platform/checksum.ts:12`
- **Evidence:** The helper recursively sorts object keys before hashing, but there is no direct test asserting a known SHA-256 vector, equivalent objects with different insertion order, nested ordering, or array-order preservation. Existing consumers generally use `checksumPayload()` itself to construct expected checksums, so they do not independently verify canonicalization.
- **Impact / failure scenario:** A refactor that stops sorting a nested object can make a database-decoded payload appear tampered merely because its property insertion order differs, causing published catalogs or last-known-good snapshots to be rejected.
- **Fix:** ADD focused unit tests with hard-coded digest vectors, differently ordered equivalent objects, nested objects, arrays, and explicit rejection or handling of non-JSON-compatible inputs.
- **Confidence:** HIGH

### F6 \[LOW]\[D3] `assertImmutable` is a test-only, misleading model surface

- **Location:** `packages/database/src/models/platform/revision.ts:180`, `packages/database/src/models/platform/revision.ts:184`, `packages/database/migrations/0145_platform_db_hardening.sql:16`
- **Evidence:** Repository-wide usage of `PlatformRevisionModel.assertImmutable()` is confined to its test. It returns successfully for an existing `draft` row, while the database trigger installed by 0145 rejects every `UPDATE OR DELETE` on `platform_resource_revisions`, regardless of status.
- **Impact / failure scenario:** The unused method duplicates an invariant now owned by PostgreSQL and falsely suggests that draft revision rows may be mutated. A future caller can pass this check and then fail unexpectedly at the trigger.
- **Fix:** Delete `assertImmutable()` and its dedicated test. Keep `PlatformRevisionImmutableError` because production service code still uses it to normalize database immutability failures.
- **Confidence:** MEDIUM

## Dimension coverage

① Checked shared models, schema indexes, transaction helpers, migration idempotency, folderMillis ordering, and lock behavior; blocking production index builds cluster in F2, while journal timestamps are unique and ordered.

② Checked skips/todos, PostgreSQL concurrency coverage, immutability tests, and critical helper coverage; F5 needs ADD coverage, and F1 needs a crash-at-retry-limit regression.

③ Checked unused exports, compatibility helpers, comments, debug output, and superseded model APIs; F6 is the confirmed dead/misleading surface.

④ Checked database/model files for user-facing copy and locale references; clean—this partition contains no applicable zh-CN UI strings.

⑤ Traced job leases, revision immutability, singleton policies, foreign keys, partial uniques, and migration constraints; issues cluster in retry-budget enforcement and unenforced policy-table invariants (F1, F3, F4).
