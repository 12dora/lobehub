# Round 5 Audit — srv-fork-seams

## Scope

Audited the fork delta under:

- `apps/server/src/routers`
- `apps/server/src/services`
- `apps/server/src/modules`
- `apps/server/src/middleware`
- `apps/server/src/libs`
- `apps/server/src/utils`
- `apps/server/src/app`

The baseline comparison found 118 touched files: 66 production files and 52 tests, with 13,608 insertions and 1,205 deletions (14,813 changed lines; net +12,403).

No fork-touched files were present under `middleware`, `libs`, `utils`, or `app`; byte-identical upstream files and unmodified upstream hunks were excluded. Of the named Round-4 remediation commits, only `4f68061410` touched this scope. This was a read-only static audit; no tests or write-capable checks were run.

## Summary

| Dimension                                      | Findings | Highest severity |
| ---------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                 |        2 | MEDIUM           |
| D2 Test decay                                  |        1 | MEDIUM           |
| D3 Dead code and development debris            |        2 | LOW              |
| D4 Missing zh-CN i18n coverage                 |        1 | LOW              |
| D5 Potential functional bugs                   |        1 | HIGH             |
| D6 Warnings and errors not surfaced via toast  |        2 | HIGH             |
| D7 Technical/internal-state-leaking UI strings |        3 | LOW              |
| D8 Missing animations/motion                   |        0 | None             |

## Findings

### srv-fork-seams-D5-1 — Strict Composio schemas break clients from the upstream baseline

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/routers/lambda/composio.ts:31-45`, `apps/server/src/routers/lambda/composio.ts:611-655`, `apps/server/src/routers/lambda/composio.test.ts:305-317`, `apps/server/src/routers/lambda/composio.test.ts:353-360`
- **Confidence:** HIGH
- **What:** The existing `getConnection` and `updateComposioPlugin` procedures changed their request contracts without a compatibility path. Both replacement schemas are strict: polling now requires `identifier` instead of `connectedAccountId`, while activation rejects the client-supplied `tools` property used by the baseline client.
- **Evidence:** At the baseline, `getConnection` accepted `{ connectedAccountId }`, and the baseline store called it in that form. The baseline activation request also included `tools`. The new tests explicitly assert that the old `tools` payload and a request containing `connectedAccountId` are rejected with `BAD_REQUEST`. By contrast, the same router preserved the obsolete `connectedAccountId` field for `deleteConnection` at lines 575-580, showing rolling-client compatibility was considered but only partially implemented.
- **Impact:** An older browser tab, desktop client, or partially rolled-out frontend cannot finish an OAuth connection after the server is upgraded. Polling fails before the handler runs, and an already-active connection cannot be materialized because activation is rejected. The integration remains pending or enters its error state under an otherwise valid normal workflow.
- **Fix:** Preserve legacy input shapes for at least the deployment compatibility window. Accept and ignore the legacy `tools` field while continuing to obtain trusted tool definitions server-side. For legacy polling, resolve `connectedAccountId` only through an owner-scoped local binding or expose a versioned legacy procedure. Add compatibility tests that replay the exact baseline client requests and verify they cannot influence server-owned tool definitions.

### srv-fork-seams-D6-1 — Remote Composio revocation failure is reported as successful deletion

- **Severity:** HIGH
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `apps/server/src/routers/lambda/composio.ts:571-603`, `apps/server/src/routers/lambda/composio.test.ts:404-436`
- **Confidence:** HIGH
- **What:** The modified deletion seam verifies ownership, but then suppresses any failure from the remote `connectedAccounts.delete` call, deletes both local projections, and returns `{ success: true }`.
- **Evidence:** Lines 594-598 catch the vendor deletion error and only call `console.warn`. Lines 600-603 then delete the plugin and connector and report success. The fork test covers only a successful remote deletion; there is no assertion for vendor failure or partial success.
- **Impact:** A user is told that an integration was removed even though the third-party account and authorization remain active. Because the local binding is deleted, the user cannot retry the revocation through the normal UI. This violates the Certainty design value and can leave an unwanted external authorization behind.
- **Fix:** Treat remote “not found” as idempotent success, but propagate other vendor failures as a typed error and retain enough local state to retry. Alternatively, persist a visible `pending_revocation` state and process it asynchronously. The client should surface the typed failure using `message.error` or base-ui `Toast`, for example: “We couldn’t disconnect this integration. Your connection is still active; try again.”

### srv-fork-seams-D6-2 — Failed human-intervention validation silently no-ops after the API reports success

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `apps/server/src/services/agentRuntime/HumanInterventionHandler.ts:69-115`, `apps/server/src/services/agentRuntime/__tests__/HumanInterventionHandler.test.ts:148-180`, `apps/server/src/services/agentRuntime/AgentRuntimeService.ts:1793-1849`, `apps/server/src/routers/lambda/aiAgent.ts:1521-1588`
- **Confidence:** HIGH
- **What:** The Round-4 receipt-hardening logic correctly fails closed for missing, stale, mismatched, or already-consumed approvals, but represents every such outcome as an unchanged state with `nextContext: undefined`. The public mutation has already returned `success: true` and “Execution resumed.”
- **Evidence:** Receipt mismatches return unchanged state at lines 83-103, and a failed atomic `approvePendingMessagePlugin` does the same at line 115. Tests explicitly codify these no-op outcomes. `processHumanIntervention` merely queues the work, while the router unconditionally says it was processed successfully.
- **Impact:** A user can click Approve, receive an apparent success, and remain indefinitely on the approval card with no explanation. This is especially likely after another tab, retry, or concurrent action consumes or changes the pending tool call.
- **Fix:** Return or persist a structured outcome such as `accepted`, `stale`, `mismatch`, or `already_consumed`. Publish the worker outcome to the client and show an i18n-backed `Toast`/`message.warning`, for example: “This approval is no longer current. Refresh the conversation and try again.” Until the worker confirms it, the synchronous endpoint should say only that the intervention was queued.

### srv-fork-seams-D1-1 — Owner-scoped Composio lookup can make an unbounded number of vendor requests

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/routers/lambda/composio.ts:203-249`, `apps/server/src/routers/lambda/composio.ts:592-657`
- **Confidence:** HIGH
- **What:** `resolveRemoteOwnedComposioAccount` follows pagination until the vendor stops returning cursors. It detects a repeated cursor, but has no maximum page count, request deadline, or cancellation signal.
- **Evidence:** The `do...while (cursor)` loop sends a new vendor request for every unique cursor. `seenCursors` only protects against repeated values; an erroneous or hostile endpoint can return unique cursors indefinitely. This helper runs in polling, activation, and deletion request paths.
- **Impact:** A single user request can consume unbounded latency and vendor quota, eventually timing out a server worker. Large accounts also incur linear page scans for every poll.
- **Fix:** Prefer an owner-filtered exact-account API if available. Otherwise enforce a documented maximum page count and overall deadline/`AbortSignal`, and return a typed retriable error when the bound is exceeded. Add tests for repeated cursors, excessive unique cursors, and cancellation.

### srv-fork-seams-D1-2 — Fork responsibilities were added to several already oversized server monoliths

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/services/aiAgent/index.ts:1-5094`, `apps/server/src/services/memory/userMemory/extract.ts:1-3028`, `apps/server/src/services/agentRuntime/AgentRuntimeService.ts:1-2904`, `apps/server/src/routers/lambda/aiAgent.ts:1-1731`, `apps/server/src/routers/lambda/agentDocument.ts:1-1365`, `apps/server/src/routers/tools/market.ts:1-1009`
- **Confidence:** HIGH
- **What:** The fork placed substantial enterprise policy, exact-pin, connector-governance, managed-memory, and sandbox-workspace logic into files already far beyond the repository’s approximately 800-line split guideline.
- **Evidence:** The fork added 700 lines to `services/aiAgent/index.ts`, 157 to memory extraction, 66 to `AgentRuntimeService`, 146 to the AI-agent router, 160 to the document router, and 313 to the market router. For example, `aiAgent/index.ts:2609-2743` now handles governance identity substitution, connector resolution, credential initialization, and two marketplace integrations in the middle of the execution orchestrator.
- **Impact:** Authorization-sensitive seams become difficult to review and test independently. Future upstream rebases are more likely to produce subtle conflicts or half-migrated policy paths.
- **Fix:** Extract narrow fork-owned adapters for connector/tool-set assembly, platform-operation setup, managed memory runtime binding, and sandbox Skill execution. Keep the upstream service/router files as thin integration seams with typed inputs and outputs.

### srv-fork-seams-D2-1 — The real-PostgreSQL start-conflict regression suite is dormant in CI

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/services/agentRuntime/__tests__/recordStartConflict.multiconn.pg.test.ts:1-46`, `apps/server/src/services/agentRuntime/__tests__/recordStartConflict.multiconn.pg.test.ts:82-186`
- **Confidence:** HIGH
- **What:** The only tests that claim to prove the Round-4 `recordStart` cross-connection locking behavior are converted to `describe.skip` unless both `TEST_SERVER_DB=1` and `DATABASE_TEST_URL` are present. No repository CI command names this suite under that environment.
- **Evidence:** Lines 27-28 select `describe.skip` by default. Repo-wide search found no reference to `recordStartConflict.multiconn.pg.test.ts`. The real-PostgreSQL failure-drill workflow sets the required environment but invokes a fixed list of other suites and does not trigger on changes under `apps/server/src/services/agentRuntime/**`.
- **Impact:** The exact TOCTOU regression that the test says PGlite cannot reproduce can regress while every normal and failure-drill CI job remains green.
- **Fix:** Add this file to the real-PostgreSQL failure-drill command list and add the service path to that workflow’s path filters. Make the drill fail if the suite reports skipped tests.

### srv-fork-seams-D3-1 — Two constructor dependencies remain after their implementations stopped using them

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `apps/server/src/services/toolExecution/index.ts:47-50`, `apps/server/src/services/toolExecution/index.ts:83-88`, `apps/server/src/services/agentRuntime/AgentRuntimeService.ts:349-357`, `apps/server/src/services/agentRuntime/HumanInterventionHandler.ts:41-45`
- **Confidence:** HIGH
- **What:** `ToolExecutionServiceDeps` still requires `mcpService`, but the constructor discards it and web MCP execution uses the `platformSafeMcpService` singleton. `HumanInterventionHandler` similarly retains an explicitly ignored `_serverDB` parameter after database access moved into `MessageModel`.
- **Evidence:** Repo-wide search found no `mcpService` use inside `ToolExecutionService` beyond the dead interface field, while `AgentRuntimeService` still constructs and passes it. `_serverDB` has no use, and the single production constructor call still supplies `db`.
- **Impact:** Tests and callers imply dependency injection and configurability that no longer exist, making mocks misleading and future refactors more error-prone.
- **Fix:** Remove `mcpService` from the dependency interface and call sites, and remove `_serverDB` plus its type import from `HumanInterventionHandler`. Update tests to construct only the dependencies actually used.

### srv-fork-seams-D3-2 — Security comments still describe connector governance as fail-open

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `apps/server/src/services/toolExecution/builtin.ts:66-73`, `apps/server/src/services/aiAgent/index.ts:2609-2622`
- **Confidence:** HIGH
- **What:** Two fork comments say the governance resolver “fails open to per-user behavior,” but the current resolver catches failures and returns `DENIED_CONNECTOR_GOVERNANCE`, a deny-all/fail-closed shape.
- **Evidence:** The comments conflict with `enterprise/services/connectorGovernance/resolve.ts`, whose documentation and catch path explicitly implement fail-closed behavior.
- **Impact:** These comments sit next to authorization-bearing identity substitution and manifest construction. A maintainer following them could incorrectly “restore” per-user fallback during an incident or rebase.
- **Fix:** Update both comments to state that inactive governance preserves per-user behavior, while resolution failures return the deny-all sentinel and must never substitute personal credentials.

### srv-fork-seams-D4-1 — Managed-agent deletion returns untranslated English copy

- **Severity:** LOW
- **Dimension:** D4 Missing Simplified Chinese i18n coverage
- **Location:** `apps/server/src/routers/lambda/agent.ts:483-503`
- **Confidence:** HIGH
- **What:** The synthetic managed-agent guard returns the user-facing English message `Platform-managed agents cannot be deleted.` directly from the server.
- **Evidence:** The surrounding comment explicitly says the rejection should surface as an error rather than false success. A repo-wide search found no locale key or zh-CN translation for this message.
- **Impact:** zh-CN users receive English or a generic fallback for a normal managed-resource restriction.
- **Fix:** Return a stable error reason such as `PLATFORM_AGENT_DELETE_DENIED` and localize it in the client.
  - **en-US:** “This Agent is managed by your organization and can’t be deleted.”
  - **zh-CN:** “此智能体由你的组织管理，无法删除。”

### srv-fork-seams-D7-1 — Managed Skill errors expose operation snapshots, proofs, IDs, and correlation tokens

- **Severity:** LOW
- **Dimension:** D7 Overly technical/internal-state-leaking UI strings
- **Location:** `apps/server/src/routers/tools/market.ts:374-428`, `apps/server/src/routers/tools/market.ts:547-583`, `apps/server/src/services/toolExecution/serverRuntimes/platformSkillWorkspace.ts:40-80`, `apps/server/src/services/toolExecution/serverRuntimes/platformSkillWorkspace.ts:111-118`
- **Confidence:** HIGH
- **What:** User-visible TRPC and tool-result errors refer to `operationId`, “operation snapshot,” “signed snapshot,” exact references, and an internal audit/correlation identifier.
- **Evidence:** Examples include `Managed Skill operationId is required`, `Managed Skill operation proof is invalid`, `operation context does not match its signed snapshot`, and `Managed Skill execution failed (<correlation-id>)`. TRPC errors are rethrown unchanged, while runtime errors are placed in `stderr` or the returned error result.
- **Impact:** Users receive implementation details they cannot act on and may expose internal identifiers in screenshots or support conversations.
- **Fix:** Keep operation, proof, snapshot, and correlation details only in structured server logs. Use:

  - **en-US:** “This Skill couldn’t run. Start a new run and try again. If the problem continues, contact your administrator.”
  - **zh-CN:** “此技能无法运行。请开始新的运行后重试；如果问题持续，请联系管理员。”

  For a missing published revision:

  - **en-US:** “This Skill is no longer available. Start a new run or ask your administrator to republish it.”
  - **zh-CN:** “此技能已不可用。请开始新的运行，或联系管理员重新发布。”

### srv-fork-seams-D7-2 — MCP device errors expose transport and isolation jargon

- **Severity:** LOW
- **Dimension:** D7 Overly technical/internal-state-leaking UI strings
- **Location:** `apps/server/src/services/mcp/index.ts:285-291`, `apps/server/src/services/toolExecution/index.ts:277-299`, `apps/server/src/services/connector/exec.ts:34-47`
- **Confidence:** HIGH
- **What:** The same user-facing failure is expressed as `Stdio MCP requires an explicitly isolated worker capability` or `Stdio MCP requires an isolated device`.
- **Evidence:** One form is a TRPC message, another is returned in both `content` and `error.message`, and the connector service throws it directly. These outputs can appear in tool cards and agent errors.
- **Impact:** “stdio,” “isolated worker,” and “capability” do not tell an ordinary user which device to connect or what action to take.
- **Fix:** Retain `MCP_STDIO_DEVICE_REQUIRED` as the internal code and display:
  - **en-US:** “This integration must run on a connected desktop device. Connect a device and try again.”
  - **zh-CN:** “此集成需要在已连接的桌面设备上运行。请连接设备后重试。”

### srv-fork-seams-D7-3 — OAuth refresh failure exposes token terminology and the internal provider identifier

- **Severity:** LOW
- **Dimension:** D7 Overly technical/internal-state-leaking UI strings
- **Location:** `apps/server/src/services/oauthDeviceFlow/refresh.ts:109-115`, `apps/server/src/services/agentRuntime/CompletionLifecycle.ts:362-381`, `apps/server/src/services/agentRuntime/CompletionLifecycle.ts:643-659`
- **Confidence:** HIGH
- **What:** An irrecoverable refresh failure is emitted as `OAuth refresh token for provider "<providerId>" is no longer valid, please re-connect`.
- **Evidence:** `CompletionLifecycle.extractErrorMessage` preserves nested runtime messages and writes the extracted message to the assistant error row, so this is not merely server logging.
- **Impact:** Users see OAuth implementation terminology and possibly a machine provider key instead of the product-facing provider name and the settings location they need.
- **Fix:** Keep the provider ID and invalid-grant details in structured logs, and display:
  - **en-US:** “Your connection to this provider has expired. Reconnect it in Provider settings, then try again.”
  - **zh-CN:** “你与此服务商的连接已过期。请在服务商设置中重新连接后再试。”

## Dimensions with no findings

- **D8 Missing animations/motion:** The touched scope contains server routers, services, and runtime modules only. No user-interface rendering, panel/list transitions, loading indicators, or motion-capable components were introduced here, so animation changes are not applicable.

## Cross-scope notes

- `.github/workflows/enterprise-failure-drills.yml:4-17,95-133` neither triggers for `apps/server/src/services/agentRuntime/**` nor invokes the in-scope PostgreSQL conflict suite.
- `src/store/tool/slices/composioStore/action.ts:273-294` optimistically removes a connection, catches deletion failures with only `console.error`, and does not roll back or toast. Agent deletion call sites such as `src/routes/(main)/home/_layout/Body/Agent/List/AgentItem/useDropdownMenu.tsx:286-304` likewise provide no explicit error toast for the new managed-agent rejection.
