# Partition: audit

## Summary

Legal-hold rechecks and stats metadata redaction are generally sound, but the partition has a critical job-publication race plus serious authorization, audit-durability, object-cleanup, and retention-accounting defects. CRITICAL: 1 · HIGH: 6 · MEDIUM: 5 · LOW: 0.

## Findings

### F1 \[CRITICAL]\[D5] Destructive jobs become runnable before their required audit record exists

- **Location:** `apps/server/src/enterprise/services/audit/retentionService.ts:192`, `apps/server/src/enterprise/services/audit/retentionService.ts:205`, `apps/server/src/enterprise/services/audit/retentionService.ts:220`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:417`, `apps/server/src/enterprise/services/audit/exportService.ts:270`, `apps/server/src/enterprise/services/audit/exportService.ts:284`, `apps/server/src/enterprise/services/audit/exportService.ts:317`, `apps/server/src/enterprise/services/audit/exportWorker.ts:184`
- **Evidence:** Retention creates a run and calls `jobsModel.enqueue(...)` before `appendAuditAccessLog(... required: true)`. Compensation happens only after a failure. Both workers immediately call `jobs.claimNext(...)`; the retention worker neither requires `run.jobId` to be linked nor verifies that the request audit record exists. Export creation uses the same enqueue-before-audit sequence.
- **Impact / failure scenario:** A worker claims an execute-retention job between enqueue and audit append. It deletes evidence, then the required append fails and the API compensates by cancelling the already-running job. The caller receives failure, no success audit record exists, but evidence has already been destroyed. An export worker can similarly materialize sensitive evidence for a request that ultimately failed its audit requirement.
- **Fix:** Create/link every run or export, enqueue its job, and append the required audit record in one database transaction so workers cannot see the job before commit. Add a concurrent-worker regression that blocks the audit append and proves no job can be claimed.
- **Confidence:** HIGH

### F2 \[HIGH]\[D5] User timeline bypasses the conversation-evidence permission and disabled policy

- **Location:** `apps/server/src/enterprise/routers/admin/audit.ts:87`, `apps/server/src/enterprise/routers/admin/audit.ts:243`, `apps/server/src/enterprise/services/audit/adminAuditService.ts:808`, `apps/server/src/enterprise/services/audit/adminAuditService.ts:814`, `packages/database/src/models/platform/auditConversation.ts:513`, `src/enterprise/client/features/admin/audit/conversations/ConversationUserPage.tsx:70`
- **Evidence:** `users.timeline` is registered with `auditRead`, while other conversation routes use `auditConversationRead`. The service loads the policy only for its time-window limit and never calls `assertConversationAccessEnabled`. The query returns topic IDs, session IDs, and titles. The UI itself treats this data as requiring `AUDIT_CONVERSATION_READ`.
- **Impact / failure scenario:** A default auditor with `AUDIT_READ` but without `AUDIT_CONVERSATION_READ` can call the endpoint directly and enumerate another user’s conversation titles and identifiers. The same endpoint continues returning them when `contentAccessMode` is `disabled`.
- **Fix:** Register `users.timeline` with `auditConversationRead` and call `assertConversationAccessEnabled(policy.contentAccessMode)` before querying.
- **Confidence:** HIGH

### F3 \[HIGH]\[D5] Disabling conversation access does not stop conversation exports

- **Location:** `apps/server/src/enterprise/services/audit/contentPolicy.ts:27`, `apps/server/src/enterprise/services/audit/exportService.ts:241`, `apps/server/src/enterprise/services/audit/exportService.ts:248`, `apps/server/src/enterprise/services/audit/exportService.ts:505`, `apps/server/src/enterprise/services/audit/exportWorker.ts:247`
- **Evidence:** The policy helper explicitly says, “Deny all conversation surfaces when content access is disabled.” Export creation checks the mode only when message bodies were requested; metadata-only conversation and timeline exports remain allowed. The worker loads the live policy but uses it only for legacy caps, and download checks permission without checking the current content mode.
- **Impact / failure scenario:** An administrator disables conversation access, but an authorized user can still create and download conversation-title/timeline exports. A body-bearing export queued before revocation will still execute and remain downloadable after revocation.
- **Fix:** Apply the disabled-policy gate to conversation and user-timeline export creation, recheck it in the worker before reading evidence, and recheck it before issuing a download URL. Terminally fail or cancel queued exports after revocation without deleting their audit metadata.
- **Confidence:** HIGH

### F4 \[HIGH]\[D5] Stats-only roles can read global conversation titles

- **Location:** `apps/server/src/enterprise/routers/admin/stats.ts:32`, `apps/server/src/enterprise/routers/admin/stats.ts:230`, `packages/database/src/models/platform/globalStats.ts:292`, `apps/server/src/enterprise/routers/admin/stats.test.ts:52`
- **Evidence:** Every stats endpoint requires only `STATS_READ`. `rankTopics()` selects `topics.id`, `topics.title`, and `topics.agentId`, not merely aggregate statistics. The tests intentionally construct a role with only `STATS_READ`.
- **Impact / failure scenario:** A reporting role without conversation-audit permission can enumerate user-authored topic titles and stable topic IDs across all users by calling `rankTopics`.
- **Fix:** Require both `STATS_READ` and `AUDIT_CONVERSATION_READ` for this endpoint, or replace the response with anonymous aggregate buckets that contain no topic IDs, titles, or agent IDs.
- **Confidence:** HIGH

### F5 \[HIGH]\[D5] Required audit records are written after cancellation and terminal worker commits

- **Location:** `apps/server/src/enterprise/services/audit/retentionService.ts:412`, `apps/server/src/enterprise/services/audit/retentionService.ts:421`, `apps/server/src/enterprise/services/audit/exportService.ts:693`, `apps/server/src/enterprise/services/audit/exportService.ts:705`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:654`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:665`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:681`
- **Evidence:** Both cancel services commit domain/job cancellation before the required audit append. The retention worker marks the run completed, then the job succeeded, and only then calls `appendWorkerOutcome(... required: true)`.
- **Impact / failure scenario:** If the append fails, cancellation remains committed while the API reports failure and lacks a success record. On worker completion, the subsequent failure handler cannot requeue an already-succeeded job, so evidence destruction remains terminal without its required outcome audit.
- **Fix:** Transactionally couple DB status transitions with the required audit insert. For external cleanup, persist a transactional cleanup outbox rather than treating object deletion as part of the audit transaction.
- **Confidence:** HIGH

### F6 \[HIGH]\[D5] Failed cleanup can leave sensitive export objects permanently orphaned

- **Location:** `apps/server/src/enterprise/services/audit/exportWorker.ts:424`, `apps/server/src/enterprise/services/audit/exportWorker.ts:458`, `apps/server/src/enterprise/services/audit/exportWorker.ts:480`, `apps/server/src/enterprise/services/audit/exportWorker.ts:511`, `apps/server/src/enterprise/services/audit/exportService.ts:698`, `packages/database/src/models/platform/auditRetention.ts:532`, `packages/database/src/models/platform/auditExport.ts:575`
- **Evidence:** `safeDelete()` suppresses every `deleteObject` failure, and cancellation performs the same best-effort suppression. Retention scans only `completed`/`expired` exports, while its purge outbox query accepts only `expired` rows. Failed or cancelled rows are never recovered.
- **Impact / failure scenario:** Upload succeeds, but checksum validation, cancellation, or domain completion then fails. If S3 deletion transiently fails, the database becomes `failed` or `cancelled` without a storage key, while the deterministic object containing conversation evidence remains indefinitely.
- **Fix:** Persist a durable purge outbox whenever an uploaded key may exist, including failed and cancelled exports. Keep retrying deletion until confirmed and add a regression with `deleteObject` failing once.
- **Confidence:** HIGH

### F7 \[HIGH]\[D5] Lease expiry can make retention report zero objects deleted after committed destruction

- **Location:** `apps/server/src/enterprise/services/audit/retentionConstants.ts:4`, `apps/server/src/enterprise/services/audit/retentionConstants.ts:5`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:1110`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:1120`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:1128`, `packages/database/src/models/platform/auditExport.ts:467`
- **Evidence:** The worker checkpoints the cursor with `exportArtifactsDeleted: 0`, then deletes as many as 50 objects without renewing its 60-second lease, and checkpoints deletion counts afterward. Object deletion and outbox completion occur sequentially inside the hold-lock transaction.
- **Impact / failure scenario:** The lease expires during slow S3 deletes. The deletes and outbox completions commit, but the post-delete count checkpoint rejects the stale owner. A replacement worker resumes after the already-advanced cursor and finds no pending outbox, so the run can complete while claiming zero deletions.
- **Fix:** Store the originating retention run in each purge outbox and atomically apply deletion accounting when completing that outbox. Alternatively, process and checkpoint one small, lease-renewed object batch at a time. Add a slow-storage, two-worker regression.
- **Confidence:** HIGH

### F8 \[MEDIUM]\[D5] “Full” monthly stats silently truncate after 100,000 records

- **Location:** `apps/server/src/enterprise/routers/admin/stats.ts:138`, `apps/server/src/enterprise/routers/admin/stats.ts:149`, `apps/server/src/enterprise/routers/admin/stats.ts:159`, `apps/server/src/enterprise/routers/admin/stats.ts:286`, `apps/server/src/enterprise/routers/admin/stats.test.ts:151`
- **Evidence:** `loadAllMonthUsage` stops after 200 pages of 500 rows and returns the accumulated array even when the final page still has `nextCursor`. The public contract claims a “full redacted set” with no pagination envelope. Its regression test uses only five rows.
- **Impact / failure scenario:** A month with 100,001 or more assistant messages returns exactly the first 100,000. Usage tables and client-side aggregates undercount without any truncation indicator.
- **Fix:** Return a paginated envelope and let the client iterate, or at minimum throw/return an explicit truncation flag when page 200 still has a cursor. Add a 201-page model-stub regression.
- **Confidence:** HIGH

### F9 \[MEDIUM]\[D5] Live audit feed hides request failures and reports failed refreshes as successful

- **Location:** `src/enterprise/client/features/admin/audit/live/LivePage.tsx:312`, `src/enterprise/client/features/admin/audit/live/LivePage.tsx:370`, `src/enterprise/client/features/admin/audit/live/LivePage.tsx:387`, `src/enterprise/client/features/admin/audit/live/LivePage.tsx:493`, `src/enterprise/client/features/admin/audit/live/LivePage.tsx:505`
- **Evidence:** Refresh timestamps advance whenever validation ends and immediately on manual refresh, without checking `error`. Both pagination functions have `try/finally` but no `catch`, and their promises are invoked with `void`. Rendering handles only forbidden errors; other topic/message failures have no error state.
- **Impact / failure scenario:** A server 500 produces an empty or stale feed labelled as freshly refreshed. “Load more” failures become unhandled promise rejections with no retry affordance.
- **Fix:** Track initial, polling, and pagination errors; catch page requests; render localized inline retry states; and update `lastRefreshedAt` only after successful mutations.
- **Confidence:** HIGH

### F10 \[MEDIUM]\[D1] Export and download paths fully buffer artifacts despite million-row limits

- **Location:** `apps/server/src/enterprise/services/audit/exportWorker.ts:274`, `apps/server/src/enterprise/services/audit/exportWorker.ts:378`, `apps/server/src/enterprise/services/audit/exportWorker.ts:402`, `apps/server/src/enterprise/services/audit/exportService.ts:577`, `packages/database/src/schemas/platform/auditAdmin.ts:197`
- **Evidence:** After streaming to a temporary file, the worker calls `readFile(tmpPath)`, uploads the full `Buffer`, then downloads the full object again for checksum verification. Download also calls `getObjectBytes`. Policy permits up to 1,000,000 rows, while evidence body size is not byte-bounded.
- **Impact / failure scenario:** A valid large conversation export can allocate the complete artifact multiple times, exhaust worker/server memory, and repeatedly crash or retry.
- **Fix:** Add an enforced artifact-byte cap while writing and before download buffering. Move upload and checksum verification to streaming or multipart I/O so memory remains bounded by a small chunk.
- **Confidence:** HIGH

### F11 \[MEDIUM]\[D1] Every retention batch reloads the entire active legal-hold table

- **Location:** `apps/server/src/enterprise/services/audit/retentionWorker.ts:157`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:814`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:874`, `apps/server/src/enterprise/services/audit/retentionWorker.ts:1049`, `packages/database/src/models/platform/auditLegalHold.ts:265`
- **Evidence:** `loadHoldIndex()` calls unbounded `listActive()`. It is invoked for every 50-row batch, even though the model documentation says batch processing should prefer targeted `findActiveScopes` or hold-class summaries.
- **Impact / failure scenario:** With many user/topic holds and many retention batches, the worker repeatedly transfers and materializes the full hold inventory, increasing database load and extending lease-sensitive work.
- **Fix:** Build the candidate batch’s distinct scope references and call `findActiveScopes`; use `summarizeActiveHoldClasses` where only conservative class presence is needed.
- **Confidence:** HIGH

### F12 \[MEDIUM]\[D2] Tests omit the concurrency and authorization cases guarding the discovered boundaries

- **Location:** `apps/server/src/enterprise/routers/admin/audit.test.ts:60`, `apps/server/src/enterprise/routers/admin/stats.test.ts:52`, `apps/server/src/enterprise/services/audit/retentionService.test.ts:202`, `apps/server/src/enterprise/services/audit/exportService.test.ts:171`
- **Evidence:** The audit test says it denies conversation read but exercises only `conversations.list`, not `users.timeline`. Stats constructs a `STATS_READ`-only role but never calls `rankTopics`. Compensation tests assert eventual cancelled states without allowing a worker to claim the already-visible job.
- **Impact / failure scenario:** Neighboring permission and cleanup assertions pass while the actual leaking routes and publish-before-audit race remain untested.
- **Fix:** **ADD** regressions for timeline with `AUDIT_READ` only, rankTopics with `STATS_READ` only, disabled-policy export creation/execution/download, concurrent worker claim during required-audit failure, cleanup retry, and lease loss during object deletion.
- **Confidence:** HIGH

## Dimension coverage

① Code smells — Export buffering and repeated unbounded legal-hold scans are reportable in F10–F11; large worker/service files otherwise have reasonably separated sections.

② Test rot — No scoped `skip`/`todo`/`only` markers were found, but critical authorization and concurrency regressions are missing as described in F12.

③ Dead code & dev cruft — No reportable unused executable code, stale compatibility path, debug output, or generated artifact was confirmed.

④ Missing Simplified-Chinese i18n — Clean: audited keys are present in en-US and zh-CN, referenced keys resolve, and no confirmed hardcoded user-facing audit/stats strings were found.

⑤ Functional bugs — Issues cluster around job publication versus audit durability, conversation authorization/policy enforcement, stats disclosure, object cleanup, lease-safe accounting, silent truncation, and UI error reporting.
