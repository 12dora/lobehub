## Partition: db

Scope reviewed: `packages/database/src/models/platform`, `packages/database/src/schemas/platform`, and `packages/database/src/repositories/platform`
Files examined: 75 `.ts`/`.tsx` files; notable areas include revisions, audit retention/legal holds, credentials, settings, global statistics, and migration-contract tests.

### Summary

The slice has generally bounded CRUD models and no files over the repository’s 800-line threshold, but several database invariants exist only in comments or service-layer conventions. The largest risks are unenforced append-only data, a cross-admin staged-secret ownership flaw, and a race that can delete evidence after a legal hold is created. Query/index mismatches and unbounded analytics materialization will become expensive at enterprise data volumes. Migration and regression coverage is inconsistent, especially for the hand-written global-credential migration. No significant dead-code, development-cruft, or zh-CN i18n findings were identified.

### Findings

#### \[HIGH] Revision and audit immutability is not enforced by PostgreSQL

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `packages/database/src/schemas/platform/revisions.ts:7`, `packages/database/src/models/platform/revision.ts:184`, `packages/database/src/schemas/platform/auditLogs.ts:7`, `packages/database/src/models/platform/auditRetention.ts:146`
- **Problem:** `platform_resource_revisions` is described as immutable and `platform_audit_logs` as append-only, but neither table has a mutation trigger. The revision model exposes an optional application check, while retention deletes audit rows directly without a guarded transaction-level escape hatch.
- **Evidence:** The schemas say `"Published rows must never be updated in place"` and `"Application code must only INSERT / SELECT"`. Repo-wide SQL search finds immutability triggers for skill and agent versions, but none for these two tables; `assertImmutable` is referenced only by its definition and one test.
- **Impact / failure scenario:** A maintenance script or future repository can update a published revision payload without changing its checksum, corrupting rollback history while existing pointers remain valid. The same class of mistake can rewrite or delete audit evidence without requiring an explicit retention transaction.
- **Recommendation:** Add PostgreSQL `BEFORE UPDATE OR DELETE` triggers. Always reject revision mutation; always reject audit-log updates and permit audit-log deletion only when a transaction calls `set_config('lobe.allow_platform_audit_log_delete', 'on', true)`. Set that GUC inside the same retention transaction and add real-Postgres trigger tests.

#### \[HIGH] Staged credential uploads are not bound to their creating administrator

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `packages/database/src/schemas/platform/credentials.ts:131`, `packages/database/src/models/platform/globalCredential.ts:360`, `packages/database/src/models/platform/globalCredential.ts:413`
- **Problem:** The SHA-256 `fileHashId` is the sole primary key and lookup condition. `stageUpload` overwrites conflicts regardless of `createdBy`, and `createFromStagedUpload` never verifies that the consuming actor owns the staged row.
- **Evidence:** The schema declares `fileHashId ... primaryKey()` while `createdBy` is nullable. The upsert targets only `platformGlobalCredentialUploads.fileHashId`; consumption filters only `fileHashId` and `expiresAt`.
- **Impact / failure scenario:** Admin A and Admin B upload identical plaintext, producing the same hash but different encrypted envelopes. B’s upload overwrites A’s row; A can then consume B’s ciphertext and register it under A’s credential. An administrator who knows a file’s content hash can similarly consume another administrator’s pending upload.
- **Recommendation:** Use a random opaque upload ID and make `createdBy` non-null. Include owner identity in every stage/read/consume/delete condition, reject cross-owner collisions, and optionally retain the content hash only as non-identifying metadata.

#### \[HIGH] Legal-hold rechecks race with destructive retention

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `packages/database/src/models/platform/auditRetention.ts:146`, `packages/database/src/models/platform/auditRetention.ts:238`, `packages/database/src/models/platform/auditLegalHold.ts:88`
- **Problem:** The final delete predicates recheck age and status but not legal holds. The worker reloads holds immediately before deletion, yet that query and the delete are separate statements with no shared lock or transaction protocol.
- **Evidence:** `deleteOperationLogsRechecked` checks only `id IN (...)` and `createdAt < cutoff`; `deleteTopicRechecked` checks only ID, cutoff, and purgeable status. The retention worker calls `listActive()` before invoking these methods.
- **Impact / failure scenario:** A retention worker completes its hold lookup, then an administrator creates a global or topic hold before the following `DELETE`. The newly protected audit evidence or conversation is irreversibly deleted despite the active hold.
- **Recommendation:** Serialize hold mutations and destructive retention with a shared transaction-level advisory lock. Perform the last hold check and database deletion in one transaction. For object-storage artifacts, use a durable tombstone/outbox workflow and recheck holds before executing the external delete.

#### \[MEDIUM] Expired active holds prevent creation of replacement holds

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `packages/database/src/schemas/platform/auditAdmin.ts:412`, `packages/database/src/schemas/platform/auditAdmin.ts:423`, `packages/database/src/models/platform/auditLegalHold.ts:88`
- **Problem:** Lookup logic treats an expired hold as inactive, but the partial unique indexes continue treating every `status = 'active'` row as active regardless of `expiresAt`.
- **Evidence:** `listActive` excludes `expiresAt <= now`, while `platform_audit_legal_holds_active_scope_unique` is predicated only on `status = 'active'`.
- **Impact / failure scenario:** A topic hold expires at noon. At 13:00 retention no longer honors it, but an administrator attempting to create a new hold for that topic receives a unique-constraint violation until the stale row is manually released.
- **Recommendation:** Before inserting, transactionally lock the scope and transition expired active rows to a terminal state with system release metadata, then insert the new hold. Add a regression test named `creates a replacement hold after the previous active hold expires`.

#### \[MEDIUM] User-setting overrides survive hard user deletion

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `packages/database/src/schemas/platform/settings.ts:97`, `packages/database/src/schemas/platform/settings.ts:120`
- **Problem:** Neither `user_setting_overrides.user_id` nor `user_setting_override_revisions.user_id` references `users.id`; therefore user deletion cannot cascade into these owned records.
- **Evidence:** Both fields are plain `text(...).notNull()` declarations. Repo-wide migration search finds no later FK, while the hard-delete path directly deletes the user row and assumes owned data cascades.
- **Impact / failure scenario:** Deleting `corp-alice` leaves her setting values and revision token behind. If the identifier is later reused, the new account inherits the deleted user’s overrides; otherwise personal configuration remains orphaned indefinitely.
- **Recommendation:** Remove existing orphans, then add `users.id` foreign keys with `ON DELETE CASCADE` to both tables. Add a hard-delete integration test asserting both tables are cleared.

#### \[MEDIUM] Global monthly usage grouping drops the final calendar day

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `packages/database/src/models/platform/globalStats.ts:429`, `packages/database/src/models/platform/globalStats.ts:442`
- **Problem:** `resolveMonthRange` returns the last day of the month as `endAt`, but the padding loop uses `date.isBefore(endDate)` and never processes that date.
- **Evidence:** The loop is `for (...; date.isBefore(endDate); ...)`. The range query itself includes the end date through the shared end-date helper, so final-day records are fetched and then discarded during grouping.
- **Impact / failure scenario:** For June, the API returns June 1–29. Assistant messages created on June 30 are loaded from PostgreSQL but never appear in the grouped response, understating requests, spend, and tokens.
- **Recommendation:** Use an exclusive first-day-of-next-month boundary consistently, or iterate while `date.isSameOrBefore(endDate, 'day')`. Add month-end, leap-year, and exact-day-count regression tests.

#### \[MEDIUM] Monthly usage endpoints materialize every raw message record

- **Dimension:** 1 / Code smells
- **Location:** `packages/database/src/models/platform/globalStats.ts:366`, `packages/database/src/models/platform/globalStats.ts:423`
- **Problem:** `findByDateRange` has no pagination or row cap and selects JSON metadata and usage for every assistant message. `findAndGroupByDay` retains every raw record inside each daily bucket.
- **Evidence:** The query ends with only `.orderBy(desc(messages.createdAt))`; there is no `.limit()`. The resulting `records` arrays are returned by the admin statistics endpoint.
- **Impact / failure scenario:** A platform with millions of monthly assistant messages loads and serializes all matching rows for one chart request, causing high database I/O, server memory pressure, oversized responses, and timeouts.
- **Recommendation:** Perform chart totals and grouping in SQL. Move detailed records to a separately paginated endpoint with a strict maximum window and add an index such as `(role, created_at)` or a partial `created_at` index for assistant messages.

#### \[MEDIUM] Audit conversation pagination lacks indexes matching its predicates and ordering

- **Dimension:** 1 / Code smells
- **Location:** `packages/database/src/models/platform/auditConversation.ts:164`, `packages/database/src/models/platform/auditConversation.ts:247`, `packages/database/src/models/platform/auditConversation.ts:492`
- **Problem:** Topic and message queries filter by user/topic and paginate by `(createdAt, id)`, but the underlying tables have only separate user/topic indexes or differently ordered composites.
- **Evidence:** Queries order by `createdAt DESC, id DESC`. The upstream topic schema has `topics_user_id_idx` but no `(user_id, created_at, id)` index; messages has separate `user_id`, `topic_id`, and `(topic_id, updated_at)` indexes but no `(user_id, topic_id, created_at, id)` index.
- **Impact / failure scenario:** An audit lookup for a user with a large conversation history requires bitmap scans and explicit sorting on every page. Title search additionally uses `%query%`, which cannot use an ordinary B-tree index.
- **Recommendation:** Add hand-written indexes matching `(user_id, created_at DESC, id DESC)` and `(user_id, topic_id, created_at DESC, id DESC)`. If title search is required at scale, add a trigram index and verify all plans with representative data.

#### \[MEDIUM] Metadata-only message lists still fetch full message bodies

- **Dimension:** 1 / Code smells
- **Location:** `packages/database/src/models/platform/auditConversation.ts:92`, `packages/database/src/models/platform/auditConversation.ts:276`
- **Problem:** The list contract claims to omit large body fields, but the query selects `messages.content` and transfers it to Node merely to calculate `hasContent`.
- **Evidence:** The projection contains `content: messages.content`, followed by `hasContent: Boolean(row.content && row.content.length > 0)`.
- **Impact / failure scenario:** Listing 200 messages with large prompts/responses transfers all raw content from PostgreSQL and temporarily exposes it to the database driver even when policy and response shape require metadata only.
- **Recommendation:** Project a SQL Boolean expression such as `COALESCE(length(content), 0) > 0 AS has_content` and never select the content column in this method.

#### \[MEDIUM] Retention performs repeated full legal-hold inventory scans

- **Dimension:** 1 / Code smells
- **Location:** `packages/database/src/models/platform/auditLegalHold.ts:194`
- **Problem:** `listActive` is unbounded and returns every active hold. The retention worker calls it initially and again before every individual topic or artifact deletion.
- **Evidence:** `listActive` has no cursor or limit. Repo-wide caller verification shows a 200-topic batch can invoke it 201 times: once to build the initial index and once per candidate before deletion.
- **Impact / failure scenario:** With 50,000 active holds and a 200-topic batch, one batch may read roughly ten million hold rows, extending leases, increasing retries, and preventing retention from making progress.
- **Recommendation:** Query only holds matching the current candidate batch, perform one serialized final recheck per batch, and use the existing `(status, scope_type, scope_id)` index. Avoid rebuilding a full inventory inside per-item loops.

#### \[MEDIUM] Global-credential migration is not safely replayable

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `packages/database/src/schemas/platform/credentials.ts:44`
- **Problem:** The hand-written migration implementing this schema uses unguarded table, FK, and index creation and has no dedicated migration-coherence test.
- **Evidence:** `0138_w10_platform_global_credentials.sql` uses bare `CREATE TABLE` at lines 1, 16, and 33, bare `ADD CONSTRAINT` at line 48, and bare `CREATE INDEX` statements at lines 49–55.
- **Impact / failure scenario:** Reapplying the migration to a partially provisioned or manually repaired environment fails on the first existing object, leaving later tables, constraints, or indexes unapplied.
- **Recommendation:** Make every step convergent with `IF NOT EXISTS`, catalog-guarded constraint creation, or explicit `DROP CONSTRAINT IF EXISTS` followed by `ADD`. Add tests that apply the migration twice and apply it over representative partial states.

#### \[LOW] Critical ownership and migration boundaries lack regression coverage

- **Dimension:** 2 / Test rot
- **Location:** `packages/database/src/models/platform/globalCredential.test.ts:188`
- **Problem:** Credential staging tests exercise only an anonymous/single-principal flow and therefore do not verify the security boundary represented by `createdBy`. There is also no in-scope migration test for the credential schema.
- **Evidence:** Both staging tests omit `createdBy` and call `consumeUpload(hash)` or `createFromStagedUpload(...)` without an actor. Existing schema migration tests cover agents, connectors, identity, jobs, and secret rotation, but not credentials.
- **Impact / failure scenario:** Cross-admin overwrite/consume behavior and non-idempotent migration SQL can regress without any failing test.
- **Recommendation:** Add tests named `rejects replacing another actor's staged upload`, `rejects consuming another actor's upload`, and `replays credential migration from empty and partial schemas`. Also add trigger, expired-hold replacement, and month-final-day regression tests for the findings above.

Dimension 3: no significant findings.

Dimension 4: no significant findings.

### Metrics

- Total findings: 12 (CRITICAL 0, HIGH 3, MEDIUM 8, LOW 1)
- Largest in-scope files (lines): `models/platform/globalCredential.ts` 597, `schemas/platform/connectors.ts` 568, `models/platform/auditConversation.ts` 562
- Dead-code candidates verified unused repo-wide: 0
