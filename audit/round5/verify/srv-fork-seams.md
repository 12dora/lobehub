# Verification — srv-fork-seams

## Verdicts

| Finding ID          | Original severity | Verdict    | Corrected severity | One-line reason                                                                                                                                                         |
| ------------------- | ----------------- | ---------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| srv-fork-seams-D5-1 | HIGH              | DOWNGRADED | MEDIUM             | Baseline payloads are rejected, but current callers are aligned; impact is limited to version-skewed Composio clients and is recoverable by loading the current bundle. |
| srv-fork-seams-D6-1 | HIGH              | REFUTED    | N/A                | The revocation failure is real, but the same catch-delete-success behavior exists in baseline `4bab163640`; it is explicitly out of scope.                              |

## Details

### srv-fork-seams-D5-1 — DOWNGRADED

- **What the original claimed:** Strict schemas reject baseline `getConnection` and `updateComposioPlugin` requests, preventing older clients from completing Composio OAuth.

- **What I actually found:** The current polling schema accepts only `identifier`, and the update schema is strict without `tools` at `apps/server/src/routers/lambda/composio.ts:31-45`. Baseline client code sent only `connectedAccountId` when polling and included `tools` when updating at `4bab163640:src/store/tool/slices/composioStore/action.ts:169-172` and `:218-230`. Current tests explicitly reproduce both rejections at `apps/server/src/routers/lambda/composio.test.ts:305-317` and `:353-360`.

- **Refutation attempts:**
  - Checked all production callers repo-wide. The current caller is aligned: polling uses `buildComposioOwnedStatusInput` at `src/store/tool/slices/composioStore/action.ts:174-177`, and activation uses the narrowed helper at `:223-226`. Its builders emit the new contracts at `src/store/tool/slices/composioStore/contract.ts:14-25`.
  - Checked the shared tRPC transport for a compatibility rewrite. `packages/trpc/src/client/lambda.ts:108-160` applies authentication headers and SuperJSON transport but no input migration or field stripping.
  - Checked the OAuth callback for server-side completion. It only closes the popup and explicitly relies on the opener polling `getConnection` at `src/app/(backend)/api/composio/oauth/callback/route.ts:3-10`.
  - Checked the managed-resource guard. It parses update input through the same strict schema at `apps/server/src/routers/lambda/composio.ts:298-307`; it provides no legacy path.
  - Checked whether the old fields were merely ignored by Zod. The explicit `.strict()` calls and rejection tests disprove that.
  - Checked baseline router contracts directly. Baseline required `connectedAccountId` for polling and required `tools` for activation at `4bab163640:apps/server/src/routers/lambda/composio.ts:282-313` and `:323-340`.

- **Verdict rationale:** The compatibility defect is reproducible. A baseline bundle talking to the current server cannot pass polling, and would also fail activation if it reached that step. However, the report overstates the blast radius: current callers are correct, the failure is confined to stale or partially rolled-out clients using Composio OAuth, and loading the current client restores a valid request path. No permanent data loss or broader authentication outage was established.

- **Corrected severity and scope:** MEDIUM. A version-skew compatibility regression affecting Composio connection completion, especially stale browser sessions and any independently deployed old client that targets the upgraded server.

### srv-fork-seams-D6-1 — REFUTED

- **What the original claimed:** A failed Composio revocation is swallowed, local state is deleted, and the API returns success, leaving an active external authorization with no normal retry path.

- **What I actually found:** Current code does behave that way: after ownership verification at `apps/server/src/routers/lambda/composio.ts:587-592`, it catches remote deletion failures at `:594-598`, deletes both local projections at `:600-601`, and returns success at `:603`. The client also removes the row optimistically and catches request failures with only logging at `src/store/tool/slices/composioStore/action.ts:273-294`.

  The decisive baseline comparison refutes it as a fork finding. Baseline already caught the vendor deletion error, deleted the plugin and connector projection, and returned `{ success: true }` at `4bab163640:apps/server/src/routers/lambda/composio.ts:257-275`. Baseline client behavior was likewise optimistic and log-only at `4bab163640:src/store/tool/slices/composioStore/action.ts:277-297`.

- **Refutation attempts:**
  - Checked whether the new owner lookup prevented the failure. It only verifies that the binding belongs to the user before revocation; it cannot make the subsequent vendor deletion succeed.
  - Checked for transaction, retry state, queue, or retained binding. None surrounds `apps/server/src/routers/lambda/composio.ts:594-603`.
  - Checked global error handling. The lambda handler logs actual tRPC errors at `src/app/(backend)/trpc/lambda/[trpc]/route.ts:31-39`, but this procedure returns success, so no global error path runs.
  - Checked tests. Current coverage exercises successful remote deletion only at `apps/server/src/routers/lambda/composio.test.ts:404-436`; baseline coverage likewise tested only success at `4bab163640:apps/server/src/routers/lambda/composio.test.ts:175-183`.
  - Compared semantics around the inherited catch. The fork changed how the trusted connector and remote ID are resolved, but not the remote-failure policy or its resulting local deletion.

- **Verdict rationale:** The underlying product defect is genuine, but it existed at the mandated upstream baseline with the same failure handling and user-visible outcome. Rule 5 therefore requires it to be marked REFUTED as out of scope.

- **Corrected severity and scope:** N/A for this fork-delta audit; this is inherited upstream behavior, not a regression introduced by the enterprise fork.
