# Verification — srv-audit

## Verdicts

| Finding ID      | Original severity | Verdict    | Corrected severity | One-line reason                                                                                                                                    |
| --------------- | ----------------- | ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| srv-audit-D5-01 | HIGH              | DOWNGRADED | MEDIUM             | Raw fingerprints are reproducibly exposed, but only through explicitly full-detail, permission-gated admin surfaces—not ordinary list reads.       |
| srv-audit-D5-02 | HIGH              | CONFIRMED  | HIGH               | Snapshot materialization has no heartbeat and an expired lease is reclaimable across workers until the three-attempt budget is exhausted.          |
| srv-audit-D1-01 | HIGH              | DOWNGRADED | MEDIUM             | Staging bytes are unbounded, but exploitation requires privileged export access and is constrained by row/window limits and eventual temp cleanup. |
| srv-audit-D1-02 | HIGH              | DOWNGRADED | MEDIUM             | Body-enabled exports issue at least one indexed message query per topic; this is a real N+1 but affects a policy-gated export mode.                |
| srv-audit-D5-03 | HIGH              | DOWNGRADED | MEDIUM             | The crash window causes durable count under-reporting, but deletion remains recoverable and the defect does not lose or over-delete evidence.      |
| srv-audit-D5-04 | HIGH              | CONFIRMED  | HIGH               | A transient metadata error is converted to “absent,” allowing the purge outbox to be finalized while the sensitive object remains.                 |
| srv-audit-D5-05 | HIGH              | CONFIRMED  | HIGH               | Both failure paths commit terminal state before the required audit append, so append failure cannot roll them back.                                |

## Details

### srv-audit-D5-01 — DOWNGRADED

- **What the original claimed:** Round-4 event detail and operation-log exports bypass the read-time fingerprint-removal boundary and expose legacy secret fingerprints.

- **What I actually found:** The canonical service recursively removes fingerprint-named fields at [platformAudit.ts:22](/Users/konata/code/AIHub/apps/server/src/enterprise/services/platformAudit.ts:22), and its regression test seeds a direct legacy row and requires removal at [platformAudit.test.ts:68](/Users/konata/code/AIHub/apps/server/src/enterprise/services/__tests__/platformAudit.test.ts:68). In contrast, admin detail maps stored diffs unchanged at [adminAuditServiceShared.ts:49](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/adminAuditServiceShared.ts:49), after reading the database model directly at [adminAuditService.ts:266](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/adminAuditService.ts:266). Operation-log exports likewise copy raw diffs at [exportWorkerSnapshot.ts:154](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorkerSnapshot.ts:154).

- **Refutation attempts:** Normal appends do pass through write-time redaction at [auditLog.ts:118](/Users/konata/code/AIHub/packages/database/src/models/platform/auditLog.ts:118), limiting exposure to legacy/directly inserted or otherwise unsanitized rows. Admin event reads require `AUDIT_READ`, and exports require `AUDIT_EXPORT`, at [audit.ts:88](/Users/konata/code/AIHub/apps/server/src/enterprise/routers/admin/audit.ts:88). The admin contract explicitly promises full stored diffs at [common.ts:5](/Users/konata/code/AIHub/apps/server/src/enterprise/contracts/adminAudit/common.ts:5), and a test deliberately expects a fingerprint to survive at [adminAuditService.test.ts:53](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/adminAuditService.test.ts:53). Those facts narrow the scope, but they do not fully refute the defect: the security threat model separately requires public audit reads to remove fingerprints at [enterprise-threat-model.md:149](/Users/konata/code/AIHub/docs/security/enterprise-threat-model.md:149).

- **Verdict rationale:** The data flow is real and conflicts with the repository’s fingerprint-specific security requirement. However, the original severity overlooks the explicit full-diff contract, permission gates, write-time sanitization, and the fact that a SHA-256 fingerprint is metadata rather than plaintext credential material.

- **Corrected severity and scope:** **MEDIUM.** Limited to privileged admin detail and exported artifacts containing legacy or bypass-inserted fingerprint fields. The relevant feature files are fork additions relative to the supplied baseline, so this is not an upstream defect.

### srv-audit-D5-02 — CONFIRMED

- **What the original claimed:** A snapshot taking longer than the 60-second lease can be reclaimed repeatedly and eventually dead-lettered.

- **What I actually found:** The default lease is 60 seconds at [exportConstants.ts:5](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportConstants.ts:5). The worker checkpoints before materialization, then calls the entire snapshot routine, and checkpoints only after it returns at [exportWorker.ts:407](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorker.ts:407) and [exportWorker.ts:425](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorker.ts:425). The comment expressly forbids heartbeats during the transaction. Materialization can page up to one million rows in batches of 100. Export jobs are created with three attempts at [exportService.ts:281](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportService.ts:281).

- **Refutation attempts:** I checked the job state machine for automatic protection. Expired running leases are explicitly claimable at [job.ts:376](/Users/konata/code/AIHub/packages/database/src/models/platform/job.ts:376), and exhausted expired jobs are dead-lettered at [job.ts:352](/Users/konata/code/AIHub/packages/database/src/models/platform/job.ts:352). The snapshot transaction does not lock the job or export rows, so another connection is not blocked from reclaiming and rebinding the attempt token. A later retention path does reconcile `running` exports linked to dead jobs at [auditExport.ts:1317](/Users/konata/code/AIHub/packages/database/src/models/platform/auditExport.ts:1317), but only after the export has already failed and remained stale.

- **Verdict rationale:** No transaction, advisory lock, heartbeat connection, or lease-duration guard prevents reclaim. The existing fencing protects publication integrity but does not keep a legitimate long snapshot alive.

- **Corrected severity and scope:** **HIGH.** Multi-worker deployments and snapshots exceeding one lease interval are affected. The behavior is fork-owned relative to the baseline.

### srv-audit-D1-01 — DOWNGRADED

- **What the original claimed:** The 256 MiB artifact limit is checked only after an arbitrarily large staging file has been materialized.

- **What I actually found:** `writeStaging()` counts rows but does not count bytes at [exportWorkerSnapshot.ts:101](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorkerSnapshot.ts:101). The byte ceiling is enforced later by `writeLine()` while copying into the final artifact at [exportWorker.ts:350](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorker.ts:350). Message `content` is an unbounded PostgreSQL `text` field and `editorData`/`error` are JSONB at [message.ts:102](/Users/konata/code/AIHub/packages/database/src/schemas/message.ts:102).

- **Refutation attempts:** The worker caps evidence rows and rejects row `maxExportRows + 1`; windows are bounded by policy; export creation is privileged; and the temporary directory is removed in `finally` at [exportWorker.ts:533](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorker.ts:533). These reduce likelihood and persistence but do not cap peak staging usage. The existing streaming test deliberately sets the cap above the artifact at [exportWorker.test.ts:965](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorker.test.ts:965), so it does not exercise early staging rejection.

- **Verdict rationale:** The staging limit gap is real. The original HIGH assessment overstates accessibility and durability: an attacker needs an audit-export-capable account and sufficiently large existing evidence, and cleanup is attempted after failure.

- **Corrected severity and scope:** **MEDIUM.** A local worker-storage exhaustion risk on exceptionally large privileged exports, not an unauthenticated or persistent storage overwrite. Fork-owned relative to baseline.

### srv-audit-D1-02 — DOWNGRADED

- **What the original claimed:** Conversation exports with message bodies execute a message query independently for every topic.

- **What I actually found:** The materializer loops over topics at [exportWorkerSnapshot.ts:204](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorkerSnapshot.ts:204) and, whenever bodies are enabled, starts a fresh `listMessageDetails()` cursor for that topic at [exportWorkerSnapshot.ts:226](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorkerSnapshot.ts:226). Thus every eligible topic causes at least one message query, including empty topics. The model query itself is scoped by both user and topic at [auditConversation.ts:319](/Users/konata/code/AIHub/packages/database/src/models/platform/auditConversation.ts:319).

- **Refutation attempts:** The query is keyset-paginated and backed by a composite user/topic/created-at/id index at [message.ts:169](/Users/konata/code/AIHub/packages/database/src/schemas/message.ts:169). Message-body export also requires `content_allowed` and `messageBodyInExport` at [exportService.ts:235](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportService.ts:235). These make each query bounded and restrict the path. They do not change the query count. The query-scaling regression test explicitly uses `includeMessageBodies: false` at [exportWorker.test.ts:1343](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorker.test.ts:1343).

- **Verdict rationale:** The N+1 is proven, but its direct effect is performance degradation on an explicitly enabled, privileged export mode. Correctness and confidentiality are not independently lost.

- **Corrected severity and scope:** **MEDIUM.** Potentially severe latency and database load for users with many topics; it also amplifies D5-02. Fork-owned relative to baseline.

### srv-audit-D5-03 — DOWNGRADED

- **What the original claimed:** A crash after the page checkpoint causes recovered object deletion not to be credited to the originating retention run.

- **What I actually found:** Artifact rows are tombstoned into a durable purge outbox at [auditRetention.ts:366](/Users/konata/code/AIHub/packages/database/src/models/platform/auditRetention.ts:366). The worker then durably checkpoints counts and advances the cursor before deleting objects at [retentionWorkerArtifacts.ts:282](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/retentionWorkerArtifacts.ts:282). On recovery, pending outboxes are drained without `runId` at [retentionWorkerArtifacts.ts:165](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/retentionWorkerArtifacts.ts:165), while normal deletion attributes counts through `runId` at [retentionWorkerArtifacts.ts:296](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/retentionWorkerArtifacts.ts:296).

- **Refutation attempts:** The durable outbox prevents loss of the deletion itself, hold authorization is rechecked, and the cursor/count checkpoint is atomic with the job lease. These guards preserve deletion safety and prevent double-scanning. They cannot restore attribution because the outbox contains no originating run identifier. The current checkpoint-retry test covers operation logs, not artifacts, at [retentionWorker.test.ts:1038](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/retentionWorker.test.ts:1038).

- **Verdict rationale:** The exact crash window is reproducible: throw after checkpoint, recover the pending outbox without `runId`, then resume after the advanced cursor. The object is deleted but `exportArtifactsDeleted` remains understated. The original severity is inflated because evidence is still deleted safely and the fault requires a narrow process-failure window.

- **Corrected severity and scope:** **MEDIUM.** Incorrect retention-run accounting after a crash between checkpoint and deletion; no evidence loss, over-deletion, or authorization bypass. Fork-owned relative to baseline.

### srv-audit-D5-04 — CONFIRMED

- **What the original claimed:** Any metadata-probe failure following a failed delete is treated as proof that the object is absent.

- **What I actually found:** For ordinary object keys, `objectExists` catches every `getObjectMetadata()` error and returns `false` at [retentionWorkerArtifacts.ts:119](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/retentionWorkerArtifacts.ts:119). The database purge orchestrator interprets `false` as absence and schedules outbox finalization at [auditExport.ts:1065](/Users/konata/code/AIHub/packages/database/src/models/platform/auditExport.ts:1065). Finalization clears the durable purge reference.

- **Refutation attempts:** The model correctly leaves the outbox pending if `objectExists` throws at [auditExport.ts:1074](/Users/konata/code/AIHub/packages/database/src/models/platform/auditExport.ts:1074), and a separate reconciliation helper similarly retains rows on HEAD failure or timeout at [auditExport.ts:300](/Users/konata/code/AIHub/packages/database/src/models/platform/auditExport.ts:300). Those guards are defeated here because the callback converts timeout, 403, credential, endpoint, and not-found failures alike into `false`. Prefix purges are safer because prefix-list errors propagate, but normal completed exports use individual object keys.

- **Verdict rationale:** A delete failure followed by any transient metadata failure can commit database deletion state while leaving the private evidence object in storage. No later scan retains its key.

- **Corrected severity and scope:** **HIGH.** Sensitive-object orphaning on storage failure for individual-key purge outboxes. Fork-owned relative to baseline.

### srv-audit-D5-05 — CONFIRMED

- **What the original claimed:** Failed retention terminalization commits the run, job, and required audit event separately.

- **What I actually found:** The terminal contract-error branch calls `runsModel.fail()`, then `jobs.fail()`, then `appendWorkerOutcome(required: true)` at [retentionWorker.ts:422](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/retentionWorker.ts:422). The exhausted-retry branch first dead-letters the job, then fails the run and appends at [retentionWorker.ts:446](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/retentionWorker.ts:446). `appendWorkerOutcome` rethrows required append failures at [retentionWorkerTerminal.ts:52](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/retentionWorkerTerminal.ts:52), but no encompassing transaction remains to roll back earlier commits.

- **Refutation attempts:** Completion is correctly transactional at [retentionWorker.ts:342](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/retentionWorker.ts:342), as is cancellation at [retentionWorker.ts:393](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/retentionWorker.ts:393). The run model restricts failure to pending/running states at [auditRetentionRun.ts:312](/Users/konata/code/AIHub/packages/database/src/models/platform/auditRetentionRun.ts:312), and job failure is lease-fenced. Neither provides cross-statement rollback. A null `jobs.fail()` result is also ignored in the contract-error branch, permitting run/job divergence.

- **Verdict rationale:** Required audit failure leaves already-terminal state without the promised worker-outcome record. Intermediate database failure can likewise commit only a prefix of the intended transition.

- **Corrected severity and scope:** **HIGH.** Terminal retention failure integrity and mandatory auditability. Fork-owned relative to baseline.

## Findings the original report MISSED

### srv-audit-MISSED-01 — HIGH: Export dead-letter terminalization has the same cross-transaction audit gap

When a transient export failure exhausts its attempts, the worker commits `jobs.fail()` first at [exportWorker.ts:610](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorker.ts:610), then invokes `terminalFailExport(..., skipJobFail: true)` at [exportWorker.ts:616](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorker.ts:616). The latter transaction fails the export and appends the required outcome at [exportWorkerTerminal.ts:140](/Users/konata/code/AIHub/apps/server/src/enterprise/services/audit/exportWorkerTerminal.ts:140).

If that second transaction or required append fails, the job remains durably `dead` while the export remains `running` and no required export-worker failure audit exists. Retention can later reconcile the domain row at [auditExport.ts:1317](/Users/konata/code/AIHub/packages/database/src/models/platform/auditExport.ts:1317), but that reconciliation does not append the missing worker outcome. This is the export analogue of srv-audit-D5-05 and merits **HIGH** severity.
