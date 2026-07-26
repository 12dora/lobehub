# Round 5 Audit — srv-audit

## Scope

Audited:

- `apps/server/src/enterprise/services/audit`
- `apps/server/src/enterprise/jobs`
- `apps/server/src/enterprise/observability`
- `apps/server/src/enterprise/services/platformObservability`
- `apps/server/src/enterprise/services/platformAudit.ts`

The supplied extensionless `services/platformAudit` path matched no file; the actual imported implementation is `platformAudit.ts`, so it was included. Total fork delta: **62 files, 14,453 added LOC, 0 deleted LOC**. All scoped files are fork-owned additions; no byte-identical upstream files or fork seams were present.

Out-of-scope callers and database models were read only where needed to verify behavior.

## Summary

| Dimension                                   | Findings | Highest severity |
| ------------------------------------------- | -------: | ---------------- |
| D1 Code smells                              |        3 | HIGH             |
| D2 Test decay                               |        1 | MEDIUM           |
| D3 Dead code and development debris         |        1 | LOW              |
| D4 Missing Simplified Chinese i18n coverage |        1 | MEDIUM           |
| D5 Potential functional bugs                |        5 | HIGH             |
| D6 Warnings/errors not surfaced via toast   |        0 | —                |
| D7 Overly technical UI strings              |        0 | —                |
| D8 Missing animations/motion                |        0 | —                |

## Findings

### srv-audit-D5-01 — Round-4 reads bypass the fingerprint-redaction security boundary

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/platformAudit.ts:22-37`; `apps/server/src/enterprise/services/audit/adminAuditService.ts:258-294`; `apps/server/src/enterprise/services/audit/adminAuditServiceShared.ts:49-54`; `apps/server/src/enterprise/services/audit/exportWorkerSnapshot.ts:130-171`
- **Confidence:** HIGH
- **What:** The dedicated audit service recursively removes every `fingerprint` field from public reads, but the Round-4 admin detail and operation-log export paths read `PlatformAuditLogModel` directly and return stored diffs unchanged.
- **Evidence:** `toPublicAuditItem()` removes keys whose lowercase name contains `fingerprint`. In contrast, `AdminAuditService.getEvent()` calls `this.logModel.findById()` and `toEventDetail()` assigns `row.afterDiff`/`row.beforeDiff` verbatim. Export materialization likewise writes the raw diffs. Blame identifies the raw projection and export code as `cdd01e65f1`, while the earlier security commit `f72cdc0cec` introduced fingerprint redaction. The existing platform-audit test seeds legacy fingerprint values and explicitly requires them to disappear from list/detail output.
- **Impact:** Sensitive OIDC fingerprint metadata in legacy or directly inserted audit rows is visible in the admin event-detail API and downloadable NDJSON exports, defeating the earlier security remediation.
- **Fix:** Export one canonical public audit-row projector from `platformAudit.ts` or the database model and apply it to admin detail and export rows. Add regression tests that seed nested fingerprint fields and verify both `events.get` and operation-log exports omit them.

### srv-audit-D5-02 — Snapshot materialization can outlive its lease and strand large exports

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/audit/exportConstants.ts:4-5`; `apps/server/src/enterprise/services/audit/exportService.ts:281-286`; `apps/server/src/enterprise/services/audit/exportWorker.ts:129-131`; `apps/server/src/enterprise/services/audit/exportWorker.ts:377-440`; `apps/server/src/enterprise/services/audit/exportWorkerSnapshot.ts:125-309`
- **Confidence:** HIGH
- **What:** The worker renews its 60-second lease before and after the entire repeatable-read snapshot, but never during materialization.
- **Evidence:** `assertNotCancelled()` checkpoints immediately before `materializeExportSnapshot()` and only runs again after it returns. Materialization may scan one million rows in 100-row pages inside one transaction. Export jobs have only three attempts. The verified `PlatformJobModel.claimNext()` behavior reclaims expired running jobs and eventually dead-letters them after the attempt budget is exhausted.
- **Impact:** On a multi-worker deployment, any snapshot taking over 60 seconds can be reclaimed and restarted repeatedly. After three expirations the platform job becomes dead while the export domain may remain `running` until a later retention reconciliation, leaving the UI stuck and producing no artifact.
- **Fix:** Maintain the job lease from a separate database connection while the repeatable-read transaction is open, or redesign snapshotting into durable chunks that can checkpoint without losing point-in-time semantics. Add a deterministic test where materialization exceeds `leaseMs` while a second worker attempts reclaim.

### srv-audit-D1-01 — The 256 MiB limit is applied only after an unbounded staging file is built

- **Severity:** HIGH
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/services/audit/exportConstants.ts:34-35`; `apps/server/src/enterprise/services/audit/exportWorker.ts:327-356`; `apps/server/src/enterprise/services/audit/exportWorker.ts:425-444`; `apps/server/src/enterprise/services/audit/exportWorkerSnapshot.ts:90-123`
- **Confidence:** HIGH
- **What:** The artifact byte ceiling protects the final artifact stream, but the preceding snapshot staging file has no byte counter or limit.
- **Evidence:** `writeStaging()` increments only `evidenceCount` before writing arbitrary JSON rows. The main worker waits for the entire staging file to finish, then enforces `maxArtifactBytes` while copying it into the final file.
- **Impact:** Large JSON diffs or message bodies can fill shared temporary storage far beyond 256 MiB before the intended safeguard fires, potentially disrupting all workers on the host.
- **Fix:** Pass the remaining byte budget into `materializeExportSnapshot()` and reject before each staging write once manifest plus staging bytes exceed the cap. Preserve the terminal `ARTIFACT_TOO_LARGE` outcome and add a low-cap regression test that asserts staging never exceeds the injected limit.

### srv-audit-D1-02 — Conversation-body exports issue message queries per topic

- **Severity:** HIGH
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/services/audit/exportWorkerSnapshot.ts:179-267`; `apps/server/src/enterprise/services/audit/exportWorker.test.ts:1278-1372`
- **Confidence:** HIGH
- **What:** With message bodies enabled, the snapshot loop calls `listMessageDetails()` separately for every topic.
- **Evidence:** The outer loop pages topics, then lines 228-262 start a new message cursor and query loop for each topic. The query-count regression test explicitly uses `includeMessageBodies: false`, so it only proves removal of the old per-topic `getTopic()` call.
- **Impact:** An export with thousands of topics performs thousands of additional queries even when many topics have no messages. This lengthens the repeatable-read transaction, increases database load, and makes the lease-expiry failure above much more likely.
- **Fix:** Add a batch/keyset model query for messages across the current topic-ID batch—or directly across the user/time range with an optional topic filter—while retaining deterministic ordering and the same repeatable-read snapshot.

### srv-audit-D5-03 — Crash recovery deletes artifacts without crediting the originating retention run

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/audit/retentionWorker.ts:203-257`; `apps/server/src/enterprise/services/audit/retentionWorkerArtifacts.ts:165-196`; `apps/server/src/enterprise/services/audit/retentionWorkerArtifacts.ts:248-316`
- **Confidence:** HIGH
- **What:** Artifact rows are claimed, the page cursor is durably advanced, and only then are objects deleted. If the process stops after the checkpoint, recovery deletes the pending objects but deliberately records no deletion count.
- **Evidence:** `claimExportArtifactsRechecked()` creates the purge outbox before `checkpointBatch()` at line 285. Recovery drains pending outboxes without `runId`, with an explicit comment that recovered deletions are not attributed. The advanced cursor prevents the original rows from being scanned again.
- **Impact:** A resumed run can finish with `exportArtifactsScanned > 0` but `exportArtifactsDeleted = 0` even though its objects were deleted. Compliance reports and operator decisions based on retention counts become incorrect.
- **Fix:** Persist the originating retention `runId` on each purge intent and atomically attribute recovery completion to that run, or retain a resumable per-run delete ledger. Test a failure through `afterBatchCheckpoint` on the `export_artifacts` scope and assert the retry reports the deletion exactly once.

### srv-audit-D5-04 — Any metadata-probe failure is treated as proof that the object is absent

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/audit/retentionWorkerArtifacts.ts:98-147`; `packages/database/src/models/platform/auditExport.ts:1065-1091`
- **Confidence:** HIGH
- **What:** After a storage deletion throws, `objectExists()` converts every `getObjectMetadata()` error into `false`.
- **Evidence:** The callback has a bare `catch { return false; }`. The verified model caller interprets `false` as “object already gone” and finalizes the purge outbox. Thus timeouts, 403s, credential failures, endpoint failures, and real not-found responses are indistinguishable.
- **Impact:** During a transient S3 or configuration failure, the database can clear the only durable purge reference while the evidence object still exists. The object then becomes an untracked sensitive-data orphan that retention can no longer discover.
- **Fix:** Return `false` only for a structured, verified not-found response. Rethrow authentication, network, timeout, bucket, and unknown errors so the outbox remains pending. Add tests for not-found versus timeout/403 behavior.

### srv-audit-D5-05 — Failed retention terminalization is not atomic with its required audit event

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/audit/retentionWorker.ts:416-468`; `apps/server/src/enterprise/services/audit/retentionWorkerTerminal.ts:10-61`
- **Confidence:** HIGH
- **What:** Successful and cancelled terminal outcomes use transactions, but both failure branches update the run, update the job, and append the required audit event as separate commits.
- **Evidence:** The contract-error path calls `runsModel.fail()`, then `jobs.fail()`, then `appendWorkerOutcome(db, { required: true })`. The exhausted-retry path has the same shape. `required: true` only rethrows an append failure; it cannot roll back already committed run/job changes.
- **Impact:** An audit-table failure can leave a terminal failed retention run with no durable worker outcome, contradicting the service’s fail-closed audit guarantees. An intermediate database failure can also leave run and job terminal states inconsistent.
- **Fix:** Move job failure, domain failure, and required audit append into one database transaction, as already done for completion. For the last transient attempt, perform `jobs.fail()` through a transaction-scoped model and terminalize the run/audit in that same transaction when the returned status is `dead`.

### srv-audit-D1-03 — Persistent workers retry outages at fixed 2–3 second intervals

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/jobs/agentRollout.ts:10-11`; `apps/server/src/enterprise/jobs/agentRollout.ts:46-60`; `apps/server/src/enterprise/jobs/auditExport.ts:8-9`; `apps/server/src/enterprise/jobs/auditExport.ts:47-64`; `apps/server/src/enterprise/jobs/auditRetention.ts:8-9`; `apps/server/src/enterprise/jobs/auditRetention.ts:47-64`; `apps/server/src/enterprise/jobs/secretRewrap.ts:10-11`; `apps/server/src/enterprise/jobs/secretRewrap.ts:47-61`
- **Confidence:** HIGH
- **What:** Every failure immediately schedules the next fixed-delay attempt; there is no failure backoff or replica jitter.
- **Evidence:** Each poller catches, writes `console.error`, and unconditionally schedules another run after 2 or 3 seconds. The operational-metrics runtime already contains a capped exponential-backoff pattern, but the job pollers do not reuse it.
- **Impact:** A database, Vault, or storage outage produces continuous reconnection pressure and repetitive stderr logs from every replica, potentially worsening recovery.
- **Fix:** Extract a shared non-overlapping worker scheduler with capped exponential backoff and jitter, resetting after a successful batch. Use the repository `debug` namespace convention for stable operational fields.

### srv-audit-D2-01 — Critical Round-4 lifecycle gaps have no regression coverage

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/enterprise/services/audit/exportWorker.test.ts:861-1007`; `apps/server/src/enterprise/services/audit/exportWorker.test.ts:1278-1372`; `apps/server/src/enterprise/services/audit/retentionWorker.test.ts:1038-1091`; `apps/server/src/enterprise/services/audit/retentionWorker.test.ts:1141-1185`
- **Confidence:** HIGH
- **What:** Existing tests cover streaming upload, no-body query counts, operation-log checkpoint retries, and successful terminal lease loss, but omit the failure cases identified above.
- **Evidence:** The query-count case explicitly disables message bodies; the streaming test sets the byte cap above the artifact and never verifies staging enforcement; the post-checkpoint retry test uses `operation_logs`, not `export_artifacts`; and no retention-worker test injects a required audit-append failure during terminal failure.
- **Impact:** The lease gap, staging-disk overrun, message N+1, artifact recovery undercount, and unaudited failed terminal state can regress or remain unfixed while the suite stays green.
- **Fix:** Add deterministic coverage for: snapshot duration beyond `leaseMs`; staging overflow before full materialization; body-enabled query scaling; post-checkpoint artifact recovery with exact-once counts; transient HEAD failure; and audit append failure during both contract-error and dead-letter terminalization.

### srv-audit-D4-01 — Export error codes fall back to raw English/internal tokens in zh-CN

- **Severity:** MEDIUM
- **Dimension:** D4 Missing Simplified Chinese i18n coverage
- **Location:** `apps/server/src/enterprise/services/audit/jobError.ts:9-24`; `apps/server/src/enterprise/services/audit/exportWorker.ts:287-299`; `apps/server/src/enterprise/services/audit/exportWorker.ts:579-600`; `src/enterprise/client/features/admin/audit/exports/ExportsPage.tsx:315-323`
- **Confidence:** HIGH
- **What:** The server publicly emits `ARTIFACT_TOO_LARGE` and `CONTENT_ACCESS_DISABLED`, but neither error key exists in the English source nor `locales/zh-CN/admin.json`. The export detail UI falls back to the raw code.
- **Evidence:** Repository-wide grep found no `audit.exports.error.ARTIFACT_TOO_LARGE` or `audit.exports.error.CONTENT_ACCESS_DISABLED` locale entry. Both codes are reachable worker outcomes.
- **Impact:** Chinese administrators see internal uppercase error tokens instead of localized, actionable guidance for normal export failures.
- **Fix:** Add these exact keys to the default/en-US and zh-CN catalogs:
  - `audit.exports.error.ARTIFACT_TOO_LARGE`
    - **en-US:** “This export is too large. Narrow the time range or filters, then try again.”
    - **zh-CN:** “导出内容过大。请缩短时间范围或收紧筛选条件后重试。”
  - `audit.exports.error.CONTENT_ACCESS_DISABLED`
    - **en-US:** “Conversation access is disabled by the current audit policy. Ask an administrator to enable it, then create a new export.”
    - **zh-CN:** “当前审计策略已关闭会话内容访问。请联系管理员启用后重新创建导出。”

### srv-audit-D3-01 — Round-4 splitting left dead injection seams and stale file headers

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `apps/server/src/enterprise/services/audit/adminAuditService.ts:55`; `apps/server/src/enterprise/services/audit/adminAuditService.ts:424-428`; `apps/server/src/enterprise/services/audit/adminAuditServiceHost.ts:3-16`; `apps/server/src/enterprise/services/audit/adminAuditServiceLegalHolds.ts:114-160`; `apps/server/src/enterprise/services/audit/exportWorkerSnapshot.ts:1-25`; `apps/server/src/enterprise/services/audit/exportWorkerTerminal.ts:1-25`; `apps/server/src/enterprise/services/audit/exportWorkerTerminal.ts:242-247`; `apps/server/src/enterprise/services/audit/retentionWorkerTerminal.ts:64-67`
- **Confidence:** HIGH
- **What:** The split introduced an unused `storage` parameter on `AdminAuditService.createLegalHold`, an unused `host.logModel` field, duplicated full worker headers, and comments describing functions that no longer follow them.
- **Evidence:** Repo-wide grep finds no read of `params.storage` in the legal-hold delegate and no `host.logModel` use. The delegate always constructs `AuditExportPrivateS3Storage`. Both worker helper files repeat the former monolithic worker header, and terminal helper files end with dangling “claim/process” or materialization comments.
- **Impact:** The public API suggests storage injection works when it does not, alternate-storage tests can silently exercise production S3 construction, and stale comments obscure ownership after the Round-4 split.
- **Fix:** Either thread the supplied storage through the legal-hold probe or remove the parameter/import; remove `logModel` from the delegated host; and replace copied/dangling headers with concise module-specific documentation.

## Dimensions with no findings

- **D6 Warnings and errors not surfaced via toast:** In-scope synchronous mutations rethrow failures, and background export/retention failures are represented as bounded job/domain statuses. Direct toast rendering belongs to the client surface; one client omission is noted below.
- **D7 Overly technical/internal-state-leaking UI strings:** Public job DTOs intentionally expose bounded codes rather than raw exception messages. The two codes that currently leak through the UI fallback are covered under D4.
- **D8 Missing animations/motion:** The scoped files contain no user-interface components or state transitions where an upstream UI-library animation can be applied.

## Cross-scope notes

- `src/enterprise/client/features/admin/audit/retention/RetentionPage.tsx:431-470` renders only counts in the run-detail drawer and never renders `detail.error`, even though `toRetentionPublic()` supplies it. A client auditor should assess failed-run feedback, actionable localized copy, and toast/inline error behavior.
