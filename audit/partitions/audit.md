## Partition: audit

Scope reviewed: `apps/server/src/enterprise/services/audit` and `src/enterprise/client/features/admin/audit`
Files examined: 52 TypeScript files (20 backend, 32 frontend); contracts, routers, database models/schemas, security registries, and EN/zh-CN locale catalogs were also verified read-only.

### Summary

The subsystem has good baseline pagination, time-window enforcement, private export storage, and complete dual-registry coverage for its admin procedures. All 21 declared target-type labels and all existing audit locale keys have matching zh-CN entries. The largest risks are destructive retention races around legal holds, non-atomic retention accounting, fail-open audit recording, and export generation over a mutable dataset. Export memory usage, live-view authorization revocation, and 15 missing audit-action labels are additional material issues.

### Findings

#### \[CRITICAL] Legal holds can lose a race with destructive retention

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/audit/retentionWorker.ts:794` (also `:865`, `:928`)
- **Problem:** Each processor reads active holds, rechecks them, and then performs the destructive operation separately. Hold creation and deletion are not serialized or checked atomically.
- **Evidence:** Operation logs use `holdsNow = await loadHoldIndex(...)`, filter IDs, then call `deleteOperationLogsRechecked(...)`; topics and artifacts follow the same check-then-delete pattern. The repository delete predicates recheck only ID/cutoff/status, not legal holds.
- **Impact / failure scenario:** The worker sees no hold, an administrator creates a global/user/topic hold immediately afterward, and the worker then permanently deletes evidence covered by the newly active hold. The same race can delete an S3 evidence artifact after a hold becomes effective.
- **Recommendation:** Make hold activation and retention deletion share a database/advisory lock or legal-hold epoch. For database rows, include an active-hold `NOT EXISTS` condition in the destructive transaction. For artifacts, persist a deletion intent, revalidate holds under the same serialization mechanism, then delete. Add deterministic race tests that insert a hold between candidate selection and deletion.

#### \[HIGH] Destruction precedes the durable retention checkpoint

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/audit/retentionWorker.ts:801` (also `:872`, `:934`, `:814`, `:887`, `:954`)
- **Problem:** Rows or objects are deleted before counts and the keyset cursor are checkpointed. The comment claiming atomic counts/cursor does not cover the destructive work.
- **Evidence:** `deleteOperationLogsRechecked()` runs at line 801, but `checkpointBatch()` follows at line 814. Topics and export artifacts have the same ordering.
- **Impact / failure scenario:** Fifty logs are deleted, then the lease expires or the checkpoint transaction fails. The next worker resumes from the old cursor, cannot see those deleted rows, and eventually completes with zero or under-reported deletion counts. The official run record and worker audit event therefore misstate irreversible destruction.
- **Recommendation:** Perform database deletion, run-count update, and job checkpoint in one transaction. Use a durable deletion journal/outbox for S3 artifacts. Add a regression seam that fails after deletion but before checkpoint and assert that final counts cannot omit deleted evidence.

#### \[HIGH] Already-expired legal holds are accepted and displayed as active

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/audit/adminAuditService.ts:915` (also `src/enterprise/client/features/admin/audit/holds/LegalHoldsPage.tsx:304`)
- **Problem:** Neither the scoped service nor the date picker rejects `expiresAt <= now`; the created row retains status `active`, while retention’s verified `listActive()` lookup excludes expired timestamps.
- **Evidence:** The service forwards `expiresAt: params.input.expiresAt` without validation, and the picker has no `disabledDate` or submit-time future check.
- **Impact / failure scenario:** An administrator accidentally selects a past timestamp. Creation succeeds and the UI shows an active hold, but the next retention run ignores it and deletes the supposedly protected evidence.
- **Recommendation:** Reject non-future expiry server-side, disable past picker values, and represent elapsed holds as `expired` or derive an effective status in public projections. Add a test proving a past expiry cannot produce a successful active hold.

#### \[HIGH] Audit recording fails open for sensitive reads and mutations

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/audit/accessLog.ts:115`
- **Problem:** `appendAuditAccessLog` catches every append failure, logs to `console.error`, and returns success to the caller. Dangerous operations invoke it only after their primary state change or signed-URL creation.
- **Evidence:** `catch (error) { console.error(...); }` at lines 134–140 swallows the failure. Policy updates, legal-hold changes, exports, downloads, and retention operations all use this helper.
- **Impact / failure scenario:** A signed evidence URL is issued or a legal hold is released, but the audit insert fails due to a constraint, transient connection error, or audit-service defect. The operation succeeds with no authoritative audit record.
- **Recommendation:** Make audit append mandatory and transactional for database mutations. For downloads, persist the access event before returning the signed URL and fail closed if it cannot be recorded. Keep best-effort behavior only for explicitly classified low-risk reads.

#### \[HIGH] Live view retains message bodies after policy or permission revocation

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `src/enterprise/client/features/admin/audit/live/LivePage.tsx:198` (also `:223`, `:339`, `:346`; `src/enterprise/client/features/admin/audit/live/MessagePane.tsx:200`)
- **Problem:** Previously fetched body-bearing pages are stored in local `olderPages`. They are reset only when user/topic changes, not when `contentAccessMode`, `includeBody`, or `AUDIT_CONVERSATION_READ` changes.
- **Evidence:** `includeBody` becomes false when policy changes, but `mergeMessagePages(olderPages.flat(), latest)` retains old bodies. `MessagePane` passes `bodyHidden={bodyHidden && !msg.content}`, so any cached message with content bypasses the hidden-body state.
- **Impact / failure scenario:** An administrator loads message bodies, then security changes the policy to `metadata_only` or revokes their permission. Polling stops returning bodies, but all previously paged bodies remain visible until the page is reloaded or another topic is selected.
- **Recommendation:** Clear body-bearing state synchronously whenever body access or permission is lost, render an explicit no-permission state, and avoid conditioning concealment on whether cached content exists. Add a component regression test for live policy and permission revocation.

#### \[HIGH] Evidence exports are built from a mutable, non-snapshot dataset

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/audit/exportWorker.ts:439` (also `:491`, `:585`; `apps/server/src/enterprise/services/audit/retentionWorker.ts:801`)
- **Problem:** The worker freezes filter criteria but pages through live tables without a repeatable snapshot or materialized row set. Retention and ordinary conversation updates can change or delete later pages during export.
- **Evidence:** Each collector repeatedly calls live model list methods with a cursor; there is no encompassing transaction or frozen ID inventory.
- **Impact / failure scenario:** An operation-log export begins, then retention deletes rows beyond the current cursor. The export silently omits them and is marked completed with a valid checksum. Mutable `updatedAt` ordering can likewise move topics across cursor boundaries, causing omissions or duplicates.
- **Recommendation:** Materialize eligible evidence IDs under a consistent snapshot, or use an immutable export watermark/version and prevent retention from removing referenced rows until completion. Add multi-page tests that mutate and delete candidates between pages.

#### \[HIGH] Export creation can leave permanently pending orphan rows

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/audit/exportService.ts:251`
- **Problem:** Export-row creation, job enqueue, and job linking are three independent writes. Unlike retention fan-out, the failure path performs no cleanup.
- **Evidence:** `exportsModel.create()` is followed by `jobsModel.enqueue()` and `setJobId()` at lines 251–268; the catch block only appends a failure audit and rethrows.
- **Impact / failure scenario:** Job enqueue fails after row creation. The request reports failure, but a `pending` export with `jobId = null` remains visible and can never be claimed; list polling may treat it as indefinitely in flight.
- **Recommendation:** Wrap row creation, enqueue, and link in one transaction, or mark the row failed on any post-create failure. Add enqueue/link failure-injection tests and assert no open orphan remains.

#### \[HIGH] Export worker buffers up to one million evidence rows in memory

- **Dimension:** 1 / CODE SMELLS
- **Location:** `apps/server/src/enterprise/services/audit/exportWorker.ts:249`
- **Problem:** Although database reads are batched, every NDJSON line is accumulated in `string[]`, then joined and copied into a `Buffer`. The configured upper bound is 1,000,000 rows.
- **Evidence:** `const lines: string[] = []`, repeated `lines.push(...)`, followed by `Buffer.from(lines.join(''), 'utf8')` at line 315.
- **Impact / failure scenario:** A body-bearing export averaging 2 KB per row can consume multiple gigabytes through strings, the joined string, and the final buffer. The worker process can OOM, retry the same work, and eventually mark a valid request failed.
- **Recommendation:** Stream NDJSON through a hashing transform into multipart/private storage, track row count and bytes incrementally, and abort before writing row `maxExportRows + 1`. Add a large-export memory regression test.

#### \[MEDIUM] Artifact checksum is never verified before download

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `apps/server/src/enterprise/services/audit/exportService.ts:494` (also `apps/server/src/enterprise/services/audit/exportWorker.ts:322`; `src/enterprise/client/features/admin/audit/exports/ExportsPage.tsx:110`)
- **Problem:** Both completion and download verify only object length. The UI opens the signed URL directly and does not validate the stored SHA-256 checksum.
- **Evidence:** The only integrity check is `meta.contentLength !== uploaded.artifactBytes`; download calls `getObjectMetadata()` and immediately signs the object.
- **Impact / failure scenario:** An object is corrupted or replaced with different bytes of the same length. The system issues a signed URL and presents the artifact as valid evidence with its original checksum.
- **Recommendation:** Store a trusted checksum in object metadata and verify it on HEAD where supported, or serve downloads through a streaming hash-verification endpoint. Provide a verified-download UX and test same-length corruption.

#### \[MEDIUM] Default frontend window can violate the backend maximum

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `src/enterprise/client/features/admin/audit/shared/timeWindow.ts:13` (also `apps/server/src/enterprise/services/audit/timeWindow.ts:51`)
- **Problem:** The frontend subtracts seven calendar days and then moves `from` backward to midnight. This usually creates a span longer than exactly seven days, while the backend rejects any span greater than `maxListWindowDays × 24h`.
- **Evidence:** `from.setDate(from.getDate() - days)` followed by `from.setHours(0, 0, 0, 0)`; the server checks `to - from > maxMs`.
- **Impact / failure scenario:** With policy `maxListWindowDays = 7`, opening the page at 15:00 creates an approximately 7-day-15-hour request. Operation logs, conversation lists, and default exports fail before the user changes any filter.
- **Recommendation:** Keep the default duration at or below the exact backend cap, or align both ends and define calendar-day semantics server-side. Extend `timeWindow.test.ts` to pass the default midday window into `resolveAuditTimeWindow({ maxListWindowDays: 7 })`.

#### \[MEDIUM] Retention performs repeated full hold inventories and per-row deletes

- **Dimension:** 1 / CODE SMELLS
- **Location:** `apps/server/src/enterprise/services/audit/retentionWorker.ts:763` (also `:823`, `:897`)
- **Problem:** `listActive()` returns the full active-hold inventory every batch, then conversation and artifact execution reload it once per candidate and perform deletes sequentially.
- **Evidence:** `loadHoldIndex()` runs before the page and again inside each topic/artifact loop at lines 865 and 928. With a batch of 50, one batch can issue roughly 50 full hold scans plus 50 serial destructive calls.
- **Impact / failure scenario:** A large retention run with many holds produces query growth proportional to candidates × total holds, prolonging leases and increasing lease-loss/retry probability.
- **Recommendation:** Replace in-memory full inventories with indexed set-based hold predicates, a versioned hold snapshot, and batched deletes. The atomic legal-hold solution should also eliminate the per-row requery.

#### \[MEDIUM] Export modal silently reuses stale filters

- **Dimension:** 5 / POTENTIAL FRONTEND/BACKEND FUNCTIONAL BUGS
- **Location:** `src/enterprise/client/features/admin/audit/exports/CreateExportModal.tsx:72`
- **Problem:** Modal fields are initialized once and are not reset on close or successful creation. URL prefilling only overwrites parameters that happen to be present.
- **Evidence:** Success calls only `setStep(0)` at line 161; `kind`, date range, action, actor, user, topic, query, and body selection remain unchanged.
- **Impact / failure scenario:** An administrator creates an operation-log export filtered to action A, later opens “New export,” and submits believing it is broad. The stale action and date range silently produce a narrower evidence package.
- **Recommendation:** Reset every field from fresh defaults whenever a new modal session starts, then apply URL-prefill parameters as a complete replacement. Add reopen-after-success and reopen-after-cancel tests.

#### \[MEDIUM] Fifteen emitted audit actions have no EN or zh-CN labels

- **Dimension:** 4 / MISSING SIMPLIFIED-CHINESE i18n
- **Location:** `src/enterprise/client/features/admin/audit/shared/format.ts:24` (also `apps/server/src/enterprise/services/audit/accessLog.ts:12`)
- **Problem:** The action union contains 30 `admin.audit.*` actions, but only 15 have locale entries. Missing actions fall through to an English-style token humanizer for every locale.
- **Evidence:** Missing from both `packages/locales/src/default/admin.ts` and `locales/zh-CN/admin.json`: `exports.{cancel,create,download,get}`, `legalHolds.{create,get,release}`, `retention.{cancel,dryRun,getRun,run,status,worker}`, and compatibility actions `admin.audit.{get,list}`. The locale catalogs contain 55 action labels and 21 target labels overall.
- **Impact / failure scenario:** A Chinese administrator sees labels such as “Audit exports download” and “Audit retention dry run” in the operation log instead of Chinese translations.
- **Recommendation:** Add explicit EN and hand-authored zh-CN keys for all 15 values and add a catalog test that compares every `AuditAccessAction`/emitted action against both locales.

#### \[MEDIUM] Several audit values and worker errors bypass translation

- **Dimension:** 4 / MISSING SIMPLIFIED-CHINESE i18n
- **Location:** `src/enterprise/client/features/admin/audit/conversations/ConversationUserPage.tsx:135` (also `:259`; `src/enterprise/client/features/admin/audit/live/MessageBubble.tsx:116`; `src/enterprise/client/features/admin/audit/holds/LegalHoldsPage.tsx:104`; `src/enterprise/client/features/admin/audit/exports/ExportsPage.tsx:309`)
- **Problem:** Conversation statuses, timeline kinds, message roles, non-global hold scope types, and backend error messages are rendered as raw values.
- **Evidence:** Direct rendering includes `{item.kind}`, `{message.role}`, `${row.scopeType}`, and `detail.error.message`. Existing zh-CN keys for hold scope types are not used in the table.
- **Impact / failure scenario:** Chinese users see `topic`, `assistant`, `completed`, `workspace`, or English worker exception text inside otherwise localized screens.
- **Recommendation:** Map all enums and safe error codes to locale keys, reuse existing hold-scope translations, and avoid exposing raw internal error messages. Add zh-CN render tests for each enum surface.

#### \[LOW] Three in-scope files exceed the repository size guideline

- **Dimension:** 1 / CODE SMELLS
- **Location:** `apps/server/src/enterprise/services/audit/retentionWorker.test.ts:1` (also `apps/server/src/enterprise/services/audit/adminAuditService.ts:1`; `apps/server/src/enterprise/services/audit/retentionWorker.ts:1`)
- **Problem:** These files are 1,078, 1,003, and 986 lines respectively, exceeding the repository’s \~800-line code-smell threshold.
- **Evidence:** `adminAuditService.ts` combines policy, events, conversations, users, and legal holds; `retentionWorker.ts` combines legal-hold policy, orchestration, and three processors.
- **Impact / failure scenario:** Cross-domain edits become difficult to review, and critical retention invariants are spread through a nearly thousand-line worker and an equally large test fixture.
- **Recommendation:** Split services by subdomain, extract hold evaluation and scope processors, and divide worker tests by operation-log, conversation, artifact, and lease/retry behavior.

#### \[LOW] A retry test never exercises a retry

- **Dimension:** 2 / TEST ROT
- **Location:** `apps/server/src/enterprise/services/audit/retentionWorker.test.ts:691`
- **Problem:** The test named “retries preserve counts via job cursor” processes five rows in one successful claim and then asserts that a second worker claims nothing.
- **Evidence:** It expects `first.outcome === 'completed'` and `second.claimed === false`; no exception, lease loss, or retry state is introduced.
- **Impact / failure scenario:** The test name suggests coverage for the exact pre-checkpoint failure risk, but it would stay green if retry accounting were broken. A separate later test covers only failure after a successful checkpoint.
- **Recommendation:** Delete the duplicate test or convert it into the missing failure-between-delete-and-checkpoint regression. Keep the valuable post-checkpoint retry test.

#### \[LOW] Four exported symbols are unused repo-wide

- **Dimension:** 3 / DEAD CODE & DEV CRUFT
- **Location:** `src/enterprise/client/features/admin/audit/shared/openAuditReasonModal.tsx:8` (also `apps/server/src/enterprise/services/audit/retentionConstants.ts:15`)
- **Problem:** Three aliased modal exports and one retention scope type have no callers or importers anywhere in the repository.
- **Evidence:** Repo-wide search finds only their declarations: `AuditReasonModalContent`, `AuditReasonModalContentProps`, `AuditReasonModalPhase`, and `AuditRetentionStoredScope`.
- **Impact / failure scenario:** The public surface suggests supported extension points that do not exist in practice and adds maintenance noise to the audit barrel.
- **Recommendation:** Remove the unused aliases and type, retaining only `openAuditReasonModal`; reintroduce narrowly if a real caller appears.

### Metrics

- Total findings: 17 (CRITICAL 1, HIGH 7, MEDIUM 6, LOW 3)
- Largest in-scope files (lines): `retentionWorker.test.ts` 1,078; `adminAuditService.ts` 1,003; `retentionWorker.ts` 986
- Dead-code candidates verified unused repo-wide: 4
