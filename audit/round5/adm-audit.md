# Round 5 Audit — adm-audit

## Scope

Audited all 42 fork-owned files under:

- `src/enterprise/client/features/admin/audit`
- `src/enterprise/client/services/adminAudit.ts`
- `src/enterprise/client/services/adminAudit.test.ts`
- `src/enterprise/client/services/adminConnectorAudit.ts`

The baseline diff contains 8,007 added lines. Every assigned file differs from upstream; no upstream-identical file was included. Server contracts, callers, and en-US/zh-CN locale catalogs were consulted only to verify client findings. No files were modified and no write-capable test or lint command was run.

## Summary

| Dimension                                     | Findings | Highest severity |
| --------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                |        2 | MEDIUM           |
| D2 Test decay                                 |        3 | MEDIUM           |
| D3 Dead code and development debris           |        1 | LOW              |
| D4 Missing Simplified Chinese i18n coverage   |        2 | MEDIUM           |
| D5 Potential functional bugs                  |        2 | HIGH             |
| D6 Warnings and errors not surfaced via toast |        2 | MEDIUM           |
| D7 Overly technical UI strings                |        1 | LOW              |
| D8 Missing animations / motion                |        1 | LOW              |

## Findings

### adm-audit-D5-01 — Permission revocation does not invalidate an in-flight user search

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/enterprise/client/features/admin/audit/shared/AuditUserSearchSelect.tsx:92-134`, `src/enterprise/client/features/admin/audit/shared/AuditUserSearchSelect.tsx:146-153`
- **Confidence:** HIGH
- **What:** The Round-4 sequencing fix invalidates requests when `runSearch()` happens to execute with `enabled=false`, but it does nothing when `enabled` changes from true to false while a previously authorized request is already in flight.
- **Evidence:** A response is accepted whenever `requestId === requestIdRef.current` at lines 110-126. The request ID is incremented for disabled searches at lines 95-100, but there is no `[enabled]` effect that increments it on permission loss. The cached `usersById` map also retains names, usernames, and email addresses.
- **Impact:** If `AUDIT_READ` is revoked during a search, the late response can still populate selectable user PII after the component has become unauthorized. Previously cached labels can also remain visible. This is a TOCTOU confidentiality regression in a shared picker used by audit, export, live view, and legal-hold flows.
- **Fix:** Add an `enabled`-edge effect that clears the debounce, increments `requestIdRef`, closes and clears options, purges `usersById`, and replaces any cached label with a non-sensitive controlled value when `enabled` becomes false. Re-check `enabled` after the awaited request before applying results.

### adm-audit-D5-02 — Revision-conflict refresh destroys the policy draft but leaves retry on the stale revision

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/enterprise/client/features/admin/audit/retention/RetentionPage.tsx:418-427`, `src/enterprise/client/features/admin/audit/retention/RetentionPage.tsx:495-506`, `src/enterprise/client/features/admin/audit/retention/RetentionPage.tsx:548-564`
- **Confidence:** HIGH
- **What:** Round 4 added a policy refresh after mutation failure, but the open reason modal captured `fields` and `policy.revision` before that refresh. Meanwhile, the refreshed `policy` prop resets every local draft field.
- **Evidence:** `expectedRevision: policy.revision` is captured in the modal payload at lines 548-555. On failure, lines 423-426 refresh policy and rethrow. The `[open, policy]` effect at lines 495-506 then overwrites all draft state. The shared reason modal was verified to keep its original content and payload builder mounted after an error, so its next submission still uses the old revision.
- **Impact:** After a concurrent policy update, retrying from the visible reason modal conflicts again, while the operator’s unsaved settings are silently replaced by the other writer’s values. Recovery requires closing and rebuilding the flow.
- **Fix:** Preserve dirty fields across the conflict refresh. Store the newly fetched revision separately, show an explicit conflict state, and rebuild or update the reason modal so the retry uses the latest revision. If server fields changed, let the operator review and reapply their preserved draft rather than resetting it automatically.

### adm-audit-D1-01 — Mutation hooks and pages revalidate the same lists twice

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `src/enterprise/client/features/admin/audit/hooks/useAdminAudit.ts:315-357`, `src/enterprise/client/features/admin/audit/exports/ExportsPage.tsx:137-153`, `src/enterprise/client/features/admin/audit/exports/ExportsPage.tsx:286-295`, `src/enterprise/client/features/admin/audit/holds/LegalHoldsPage.tsx:79-96`, `src/enterprise/client/features/admin/audit/holds/LegalHoldsPage.tsx:168-209`, `src/enterprise/client/features/admin/audit/retention/RetentionPage.tsx:125-175`, `src/enterprise/client/features/admin/audit/retention/RetentionPage.tsx:177-192`
- **Confidence:** HIGH
- **What:** Each mutation hook already awaits a predicate-based `softRefresh`, but the page callback immediately fires the bound SWR `mutate()` again.
- **Evidence:** For example, `cancelExport` refreshes all export-list keys at `useAdminAudit.ts:325-328`; `ExportsPage` then calls `void mutate()` at line 146. The same duplication exists for export creation, legal-hold creation/release, and retention run creation/cancellation.
- **Impact:** Every normal mutation issues at least two sequential list requests. These list endpoints also record audit-access events, so the duplication adds network load and noisy evidence records. The second, unawaited refresh also bypasses the warning behavior added by Round 4.
- **Fix:** Make cache invalidation owned by one layer. Prefer keeping the mutation-hook `softRefresh` and removing page-local success revalidations, or return a refresh promise/result that callers use exactly once.

### adm-audit-D2-01 — Round-4 search tests omit the permission-revocation race

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/enterprise/client/features/admin/audit/shared/AuditUserSearchSelect.test.tsx:57-118`
- **Confidence:** HIGH
- **What:** The new test suite covers out-of-order queries and an initially disabled component, but never changes `enabled` while a request is pending.
- **Evidence:** The first test rerenders only by typing “alice” then “bob”; the second mounts with `enabled={false}`. There is no `rerender({enabled:false})` before resolving a deferred authorized request and no assertion that cached options/PII are purged.
- **Impact:** The permission defect in adm-audit-D5-01 passes the exact Round-4 regression suite intended to protect request sequencing.
- **Fix:** Add a deferred-request test that starts enabled, changes `enabled` to false, resolves the old request, and asserts that no result, email, username, or cached label appears.

### adm-audit-D2-02 — Round-4 policy-conflict remediation has no page-level regression test

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/enterprise/client/features/admin/audit/retention/RetentionPage.execute.test.tsx:144-188`, `src/enterprise/client/features/admin/audit/retention/RetentionPage.tsx:418-427`
- **Confidence:** HIGH
- **What:** The only retention page test covers execute confirmation. It does not render the policy editor, simulate a revision conflict, resolve the refresh, or retry.
- **Evidence:** `RetentionPage.execute.test.tsx` contains one test whose assertions concern `retentionRun`, `retentionDryRun`, and the danger flag. The Round-4 catch/refresh branch is unexercised.
- **Impact:** The stale retry and draft-reset behavior in adm-audit-D5-02 landed as remediation without coverage and can regress further unnoticed.
- **Fix:** Add a page-level conflict test that edits multiple policy fields, rejects the first update with a revision conflict, supplies a newer policy revision, and verifies both draft preservation and a successful retry using the new revision.

### adm-audit-D2-03 — Export creation, cancellation, and browser download have no UI regression coverage

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/enterprise/client/features/admin/audit/exports/CreateExportModal.tsx:62-338`, `src/enterprise/client/features/admin/audit/exports/ExportsPage.tsx:72-345`, `src/enterprise/client/services/adminAudit.test.ts:78-84`
- **Confidence:** HIGH
- **What:** Neither export component has a test file. The service test only verifies that `downloadExport` forwards its input.
- **Evidence:** The scoped file inventory contains only `CreateExportModal.tsx` and `ExportsPage.tsx` in `exports/`. No test exercises URL handoff reset, policy-gated message bodies, reason-modal payloads, cancellation, signed-URL navigation, or mutation failure feedback.
- **Impact:** A sensitive, long-running export workflow can break at the UI boundary while the forwarding-only service test remains green.
- **Fix:** Add component tests for create payload construction, reopened-modal reset, content-policy gating, cancellation, failed export display, successful signed-URL activation, and failure feedback.

### adm-audit-D4-01 — Actual export failure codes fall back to untranslated internal tokens

- **Severity:** MEDIUM
- **Dimension:** D4 Missing Simplified Chinese i18n coverage
- **Location:** `src/enterprise/client/features/admin/audit/exports/ExportsPage.tsx:315-324`
- **Confidence:** HIGH
- **What:** The drawer uses the raw server code as `defaultValue` when a translation key is missing. Current server-emitted codes `ARTIFACT_TOO_LARGE`, `CONTENT_ACCESS_DISABLED`, and `INTERNAL_ERROR` have no corresponding en-US or zh-CN entries.
- **Evidence:** Lines 319-322 call `t(audit.exports.error.<code>, { defaultValue: detail.error.code })`. Repository-wide locale lookup found no keys for those three codes, while the server export worker emits the first two and uses `INTERNAL_ERROR` as its generic fallback.
- **Impact:** Common export failures display uppercase implementation tokens in both English and Simplified Chinese instead of actionable guidance.
- **Fix:** Add these exact copies and remove the raw-code fallback:

  - `ARTIFACT_TOO_LARGE`
    - en-US: “The export file is too large. Narrow the date range and create a new export.”
    - zh-CN: “导出文件过大。请缩小日期范围后重新创建导出。”
  - `CONTENT_ACCESS_DISABLED`
    - en-US: “Conversation content access is disabled by your audit policy. Update the policy or export metadata only.”
    - zh-CN: “审计策略已禁用对话内容访问。请更新策略或仅导出元数据。”
  - `INTERNAL_ERROR`
    - en-US: “The export couldn’t be completed. Try creating it again.”
    - zh-CN: “导出未能完成，请重新创建后再试。”

### adm-audit-D6-01 — Failed retention jobs discard their public error reason

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `src/enterprise/client/features/admin/audit/retention/RetentionPage.tsx:195-279`, `src/enterprise/client/features/admin/audit/retention/RetentionPage.tsx:431-470`
- **Confidence:** HIGH
- **What:** Retention run items include a public bounded error code, but the table and detail drawer never read `row.error` or `detail.error`.
- **Evidence:** Failed rows show only a “failed” status. The drawer renders scan/delete counts exclusively. A scoped grep found no retention item error access anywhere in the page.
- **Impact:** A background cleanup can fail after the initiating modal has closed, yet the operator receives no toast, explanation, or persistent retry guidance.
- **Fix:** When polling observes an in-flight run transition to `failed`, emit one `toast.error` from `@lobehub/ui/base-ui`. Also render a localized, actionable error block in the drawer with a “Create new run” or “Run dry check” action. Avoid repeat toasts on initial historical-list load.

### adm-audit-D6-02 — Auxiliary evidence fetches silently degrade into plausible partial data

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `src/enterprise/client/features/admin/audit/operationLogs/OperationLogsPage.tsx:182-187`, `src/enterprise/client/features/admin/audit/conversations/ConversationUserPage.tsx:119-139`, `src/enterprise/client/features/admin/audit/conversations/ConversationUserPage.tsx:195-260`, `src/enterprise/client/features/admin/audit/conversations/ConversationTopicPage.tsx:94-125`, `src/enterprise/client/features/admin/audit/conversations/ConversationTopicPage.tsx:146-150`
- **Confidence:** HIGH
- **What:** Operation-log stats/facets, user summary, and conversation detail failures are ignored unless they happen to be authorization errors.
- **Evidence:** `OperationLogsPage` destructures only `data` from stats and facets. `ConversationUserPage` renders summary fields as dashes without checking `summary.error`. `ConversationTopicPage` uses detail errors only to detect `FORBIDDEN`; other failures become a generic title and missing metadata.
- **Impact:** Auditors can mistake missing aggregates or identity/topic metadata for authoritative empty data. There is no toast or retry path for the failed section.
- **Fix:** Track each auxiliary error explicitly, show a persistent section-level unavailable state with retry, and emit a deduplicated `toast.error` such as “Some audit summary data couldn’t be loaded. Retry to refresh the missing sections.”

### adm-audit-D1-02 — Redacted-message rendering is duplicated across evidence and live views

- **Severity:** LOW
- **Dimension:** D1 Code smells
- **Location:** `src/enterprise/client/features/admin/audit/conversations/ConversationTopicPage.tsx:64-75`, `src/enterprise/client/features/admin/audit/live/MessageBubble.tsx:75-86`
- **Confidence:** HIGH
- **What:** Both files independently split message text with the same `[REDACTED…]` regular expression and construct equivalent highlighted spans.
- **Evidence:** The two `renderBody` functions are line-for-line equivalent apart from their locally defined style class.
- **Impact:** Changes to masking markers, accessibility, or copy can drift between live monitoring and stored evidence—the two surfaces that most need consistent redaction semantics.
- **Fix:** Extract one shared `RedactedMessageBody` component or tokenization utility under `shared/`, with one test covering marker parsing and plain text.

### adm-audit-D3-01 — Cursor pagination exposes two unused public controls

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `src/enterprise/client/features/admin/audit/shared/useCursorPagination.ts:22-33`, `src/enterprise/client/features/admin/audit/shared/useCursorPagination.ts:67-80`
- **Confidence:** HIGH
- **What:** `CursorPaginationControls` exposes `cursorStack` and `setCursorStack`, but no repository caller consumes either member.
- **Evidence:** Repository-wide grep found these names only in the hook declaration/return and in separate page-local `useState` implementations—not as destructured results of `useCursorPagination`.
- **Impact:** The hook’s public surface implies unsupported escape hatches and forces tests/mocks to reproduce dead API.
- **Fix:** Remove both returned members and their interface fields. If direct stack control is genuinely needed later, add a named semantic action instead of exporting raw state setters.

### adm-audit-D4-02 — Stored evidence renders message roles without localization

- **Severity:** LOW
- **Dimension:** D4 Missing Simplified Chinese i18n coverage
- **Location:** `src/enterprise/client/features/admin/audit/conversations/ConversationTopicPage.tsx:207-214`
- **Confidence:** HIGH
- **What:** The evidence page renders `msg.role` directly, unlike the live message component, which uses the existing localized role catalog.
- **Evidence:** Line 210 contains `<Tag>{msg.role}</Tag>`. Existing keys already cover all four contract roles.
- **Impact:** zh-CN users see `user`, `assistant`, `system`, or `tool` in English/internal enum form in stored evidence.
- **Fix:** Use `audit.live.message.role.${msg.role}` with these exact copies:

  - `user`: en-US “User”; zh-CN “用户”
  - `assistant`: en-US “Assistant”; zh-CN “助手”
  - `system`: en-US “System”; zh-CN “系统”
  - `tool`: en-US “Tool”; zh-CN “工具”

### adm-audit-D7-01 — Retention confirmations and completion copy expose revision jargon and run IDs

- **Severity:** LOW
- **Dimension:** D7 Overly technical / internal-state-leaking UI strings
- **Location:** `src/enterprise/client/features/admin/audit/retention/RetentionPage.tsx:405-408`, `src/enterprise/client/features/admin/audit/retention/RetentionPage.tsx:548-564`
- **Confidence:** HIGH
- **What:** The policy reason modal labels its target as `rev <number>`, and cleanup completion copy prints one or more opaque run IDs.
- **Evidence:** `targetLabel: \`rev ${policy.revision}\``is passed to a modal that visibly prefixes it with “Target”. The highlight message interpolates`highlightIds.join (', ')\`; current translations are “New run (s): {{ids}}” and “新建运行：{{ids}}”.
- **Impact:** Operators are shown internal concurrency terminology and identifiers without an actionable explanation. The IDs add visual noise even though the rows are already highlighted.
- **Fix:** Use these exact replacements:

  - Policy target:
    - en-US: “Retention policy”
    - zh-CN: “保留策略”
  - Highlight status:
    - en-US: “New cleanup runs are highlighted below.”
    - zh-CN: “新的清理任务已在下方高亮显示。”

  Keep an ID available only in a detailed evidence field or copy action when identification is actually needed.

### adm-audit-D8-01 — Message entrance tracking mutates refs during render, so React can consume the animation before commit

- **Severity:** LOW
- **Dimension:** D8 Missing animations / motion
- **Location:** `src/enterprise/client/features/admin/audit/live/MessagePane.tsx:103-145`
- **Confidence:** HIGH
- **What:** The Round-4 animation fix writes `topicIdRef`, `knownIdsRef`, and `isFirstPaintRef` during render and inside `useMemo`.
- **Evidence:** Lines 111-116 reset refs in the component body; lines 120-145 compute entries and then immediately mark all IDs known. React 19 Strict Mode or concurrent rendering may restart or abandon that render, leaving the refs mutated even though no row committed.
- **Impact:** A genuine live append can be treated as already seen and pop into place without its intended entrance animation. The current test does not render under Strict Mode or simulate an interrupted render.
- **Fix:** Keep render pure: derive candidates from the last committed ref and update the known-ID snapshot in `useLayoutEffect` after commit. Apply the entrance through `createStaticStyles` keyframes using `cssVar.motionDurationFast` and `cssVar.motionEaseInOut`, with `@media (prefers-reduced-motion: reduce) { animation: none; }`. No new animation dependency is needed.

## Dimensions with no findings

None. All eight dimensions produced at least one verified finding.

## Cross-scope notes

The client presents the topic list as live activity and sorts loaded rows by `updatedAt` (`shared/topicListUtils.ts:21-23`), but the server model paginates and orders topics by `createdAt` (`packages/database/src/models/platform/auditConversation.ts:178-205`). An old topic receiving new messages will not re-enter the polled head unless it was already loaded. The server/audit-data auditor should verify whether the endpoint should order and cursor by `updatedAt` instead.
