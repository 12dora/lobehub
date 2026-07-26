# Verification — srv-security-guards

## Verdicts

| Finding ID                 | Original severity | Verdict    | Corrected severity | One-line reason                                                                                                                                                      |
| -------------------------- | ----------------- | ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| srv-security-guards-D5-001 | HIGH              | DOWNGRADED | LOW                | The Node defect is reproducible, but the only production use is an admin AI chat probe; no revocation, deletion, health-check, or conditional-request caller exists. |

## Details

### srv-security-guards-D5-001 — DOWNGRADED

- **What the original claimed:** The fetch adapter supplies a non-null empty body for 204, 205, and 304 responses, causing valid SDK operations and enterprise connection tests to fail broadly.

- **What I actually found:** The adapter does unconditionally construct `Response` with `new Uint8Array(response.body)` at `apps/server/src/enterprise/security/outboundHttp/safeOutboundFetchAdapter.ts:298-304`. The buffered client preserves arbitrary transport statuses through `toResponse` at `apps/server/src/enterprise/security/outboundHttp/safeOutboundHttpClient.ts:140-142,415-427`, so no upstream status normalization prevents this path.

  I reproduced the exception for all three statuses through the real `SafeOutboundHttpClient` → `createSafeOutboundFetchAdapter` chain under Node. This is relevant to production because the Docker image uses Node 24 and launches with Node at `Dockerfile:2-5,345-351`.

  However, repo-wide search found only one production constructor call, in `apps/server/src/enterprise/services/aiCatalog/connectionTestService.ts:94-104`. It performs a non-streaming AI chat probe at `apps/server/src/enterprise/services/aiCatalog/connectionTestService.ts:106-133`; none of the report’s revocation, deletion, health-probe, or conditional-request examples use this adapter. The OpenAI-compatible path expects and transforms a chat-completion payload at `packages/model-runtime/src/core/openaiCompatibleFactory/index.ts:714-718,748-774`, so an empty 204/205/304 response is not an ordinary successful result for that caller.

- **Refutation attempts:**

  - Checked for a buffered-client status guard: none exists. `SafeOutboundHttpClient.fetch` returns the status unchanged.
  - Checked the cited no-body protection: it applies only to `streamFetch` through `defaultPinnedStreamingTransport` at `apps/server/src/enterprise/security/outboundHttp/transport.ts:261-272`; the adapter calls buffered `client.fetch`.
  - Tested runtime variation: Bun accepted the construction, but Node rejected it. The production Docker runtime is Node, so this does not refute the technical defect.
  - Grepped the entire repository for adapter callers and barrel imports. Only the AI connection-test service constructs it; the export at `apps/server/src/enterprise/security/outboundHttp/index.ts:27-30` has no additional production consumer.
  - Inspected access guards. Explicit testing requires authentication, active-user and rate-limit middleware, plus `AI_PROVIDER_TEST` permission at `apps/server/src/enterprise/routers/admin/aiCatalog.ts:62-65,292-300`. Automatic publish probes are likewise restricted to privileged admin flows at `apps/server/src/enterprise/routers/admin/aiCatalog.ts:72-106,116-131`.
  - Checked error handling. Probe exceptions become a sanitized failure result at `apps/server/src/enterprise/services/aiCatalog/connectionTestService.ts:146-165`; they do not crash the server or escape as an unsurfaced outage.
  - Checked tests. The adapter fixture always returns status 200 at `apps/server/src/enterprise/security/outboundHttp/safeOutboundFetchAdapter.test.ts:11-22`, while existing 204/205/304 coverage exercises only the streaming transport at `apps/server/src/enterprise/security/outboundHttp/safeOutboundHttpClient.client.test.ts:141-168`.
  - Compared against baseline `4bab1636408e60a7ee17b640490fbf33a310a325`. The adapter file is absent there and was fork-added, so the issue is not excluded as an identical upstream defect.

- **Verdict rationale:** The fetch-compatibility defect is real under the production Node runtime, so full refutation is not justified. HIGH severity is unsupported: the supposed common no-content operations have no caller, the reachable surface is a privileged AI chat connection test, and such responses do not constitute normal successful chat completions.

- **Corrected severity and scope:** **LOW.** This is a narrow internal adapter-contract defect with no security bypass, data loss, or broad runtime outage. It matters if the adapter gains callers that legitimately expect bodyless responses; the current production caller is limited to admin AI-provider probing and publication readiness.
