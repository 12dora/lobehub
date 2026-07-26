# Round 5 Audit — srv-connector

## Scope

Audited 85 fork-touched files across:

- `apps/server/src/enterprise/services/connectorCatalog`
- `apps/server/src/enterprise/services/connectorGovernance`
- `apps/server/src/enterprise/services/platformGlobalCredentials`
- `apps/server/src/services/connector`
- `apps/server/src/services/oauthDeviceFlow`

Fork delta: 19,578 changed lines (+19,558/-20) versus `4bab1636408e60a7ee17b640490fbf33a310a325`.

Excluded as upstream-identical:

- `apps/server/src/services/connector/oauth.ts`
- `apps/server/src/services/connector/stateStore.ts`
- `apps/server/src/services/connector/tokens.ts`
- `apps/server/src/services/oauthDeviceFlow/providers/githubCopilot.ts`
- `apps/server/src/services/oauthDeviceFlow/__tests__/providers/githubCopilot.test.ts`

Round-4 remediation commits were inspected; `4f68061410` is the listed remediation commit intersecting this scope. Surrounding callers, schemas, repositories, UI error presentation, and locale files were read only to verify impact. No tests or write-capable checks were run in the read-only sandbox.

## Summary

| Dimension                                             | Findings | Highest severity |
| ----------------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                        |        1 | MEDIUM           |
| D2 Test decay                                         |        2 | MEDIUM           |
| D3 Dead code and development debris                   |        1 | LOW              |
| D4 Missing Simplified Chinese i18n coverage           |        1 | LOW              |
| D5 Potential functional bugs                          |        2 | HIGH             |
| D6 Warnings and errors not surfaced via toast         |        0 | —                |
| D7 Overly technical/internal-state-leaking UI strings |        2 | MEDIUM           |
| D8 Missing animations/motion                          |        0 | —                |

## Findings

### srv-connector-D5-1 — A banned shared-OAuth owner remains an executable organization identity

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/connectorGovernance/adminService.ts:100-116`; `apps/server/src/enterprise/services/connectorGovernance/service.ts:86-102`; `apps/server/src/enterprise/services/connectorCatalog/runtimeIntegration.ts:612-628`; `apps/server/src/enterprise/services/connectorCatalog/runtimeAdapter.ts:468-493`
- **Confidence:** HIGH
- **What:** Shared authorization validates only that the owner row exists. Neither governance resolution nor runtime binding loading checks whether that owner is permanently or temporarily banned. Active users can therefore continue executing organization-wide connector calls with the banned owner’s OAuth binding.
- **Evidence:** `setSharedAuthorization` selects only `users.id`. The resolver copies `ownerUserId` directly into `sharedAuthOwnerUserId`, and runtime uses it as `effectiveBindingUserId`. `loadBinding` validates binding ownership, revision, status, and token fields but never the owner’s user status. The user schema has `banned` and `banExpires`, while the binding repository query only reads `platformUserConnectorBindings`.
- **Impact:** Disabling an identity does not disable its delegated machine credential. Calls continue under an identity administrators intended to revoke, affecting every user governed by shared OAuth.
- **Fix:** At assignment, reject effectively banned owners. At every shared-identity execution, live-check `banned` plus `banExpires` before resolving or refreshing the binding and fail closed if inactive. Do not rely solely on the cached governance document. Add permanent-ban, active temporary-ban, expired temporary-ban, and owner-deletion coverage.

### srv-connector-D5-2 — Emergency archive and binding revocation require healthy credential decryption

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/catalogAudit.ts:16-41`; `apps/server/src/enterprise/services/connectorCatalog/publicationService.ts:349-397`; `apps/server/src/enterprise/services/connectorCatalog/publicationService.ts:441-486`; `apps/server/src/enterprise/services/connectorCatalog/publicationService.ts:702-762`
- **Confidence:** HIGH
- **What:** Both emergency operations load/decrypt connector secrets before changing state. `archive` additionally resolves every secret referenced by the published revision even though rollback is the only mode requiring usable credentials.
- **Evidence:** `sanitizeConnectorReason` calls `loadCurrentSecretSources`; any read/decrypt failure becomes `PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED`. `archive` calls this before its `try`, then `preflightRevision(..., 'archive')` unconditionally sets `resolved: await this.resolvePayloadSecrets(payload)`. `revokeAllBindings` likewise sanitizes through the secret loader before entering its revocation transaction.
- **Impact:** Missing/corrupt secret rows or a KMS/secret-service outage prevent administrators from archiving a connector or revoking compromised grants. The connector remains published and becomes usable again when the credential backend recovers.
- **Fix:** Make emergency-stop paths independent of secret plaintext. For archive, verify the immutable revision/checksum and clear or preserve opaque references without decrypting them. For reason sanitization failure, use a fixed safe audit reason instead of persisting the unsanitized input. Binding revocation must proceed without loading connector credentials.

### srv-connector-D1-1 — Every OAuth secret write can trigger an unthrottled N+1 orphan scan

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/platformConnectorSecretStore.ts:169-185`; `apps/server/src/enterprise/services/connectorCatalog/platformConnectorSecretStore.ts:344-462`; `apps/server/src/enterprise/services/connectorCatalog/userOAuthService.ts:159-171`; `apps/server/src/enterprise/services/connectorCatalog/userOAuthService.ts:390-404`; `apps/server/src/enterprise/services/connectorCatalog/connectorOAuthRefreshCoordinator.ts:129-145`; `apps/server/src/enterprise/services/connectorCatalog/secretCleanup.ts:15-25`; `apps/server/src/enterprise/services/connectorCatalog/secretCleanup.ts:204-217`
- **Confidence:** HIGH
- **What:** `persistSecret` invokes `garbageCollectOrphanedSecrets()` before every non-transactional write. The GC selects up to 100 candidates and then opens a separate lock/update transaction for each candidate.
- **Evidence:** PKCE creation, callback token persistence, and refresh-token persistence call `persistSecret` without a transaction. The candidate query does not exclude live references; exclusion happens only inside each per-row update. Consequently, the same oldest 100 live referenced secrets can be selected and rejected repeatedly. Round-4 added a five-minute throttle to the worker and explicitly documents the missing leading index, but the request-path invocation bypasses that throttle.
- **Impact:** Normal connect and refresh requests may wait for a full-table/index-poor scan plus up to 100 transactions before the new token is encrypted and stored. Under accumulated history this creates avoidable database load and increases the chance that rotating-token persistence misses operational deadlines.
- **Fix:** Remove orphan GC from `persistSecret`; use the durable worker exclusively. Alternatively, share the worker throttle and move live-reference filtering into a set-based candidate query/update with an appropriate supporting index.

### srv-connector-D2-1 — Shared-owner lifecycle tests cover identity matching but not owner deactivation

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/enterprise/services/connectorGovernance/service.test.ts:109-117`; `apps/server/src/enterprise/services/connectorCatalog/runtimeAdapter.test.ts:561-606`
- **Confidence:** HIGH
- **What:** The new shared-OAuth tests establish only the active-owner happy path and rejection of bindings belonging to another identity. They do not cover a banned, temporarily banned, or deleted designated owner.
- **Evidence:** `service.test.ts` asserts that `'gov-owner'` is exposed when governance is active. `runtimeAdapter.test.ts` checks owner binding selection and third-party ownership mismatch. A scope-wide search found no `banned`, `banExpires`, or inactive-owner scenario in governance/catalog tests. Separate router tests cover the invoking user, not the shared credential owner.
- **Impact:** The authorization-lifecycle gap in `srv-connector-D5-1` can regress unnoticed despite Round-4 tests claiming inactive-principal enforcement.
- **Fix:** Add end-to-end service tests proving no binding load, refresh, secret resolution, or outbound request occurs for permanent bans, unexpired temporary bans, and deleted owners; verify expired temporary bans are handled according to the repository’s effective-ban semantics.

### srv-connector-D2-2 — Emergency-stop tests exercise only healthy secret storage

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/publicationService.test.ts:625-681`; `apps/server/src/enterprise/services/connectorCatalog/publicationService.test.ts:684-742`
- **Confidence:** HIGH
- **What:** Archive and bulk revocation tests use a fully functioning secret store. The nearby resolver-failure test exercises only `ConnectorCatalogReadService`, not either emergency mutation.
- **Evidence:** The archive test verifies preservation of a healthy published secret fingerprint. The bulk-revoke test uses the normal harness and then archives normally. The failure test at lines 657-681 injects a failing `resolveSecretVersion` only into a read service.
- **Impact:** The unsafe dependency identified in `srv-connector-D5-2` has no regression guard, even though emergency operations are most important when credential infrastructure is unhealthy.
- **Fix:** Add tests for missing secret rows, decryption failure, and secret-service outage. Assert that archive and binding revocation still commit, invalidate runtime state, and write a non-secret audit record.

### srv-connector-D7-1 — Managed tool failures are returned as raw internal contract codes

- **Severity:** MEDIUM
- **Dimension:** D7 Overly technical/internal-state-leaking UI strings
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/runtimeIntegration.ts:77-80`; `apps/server/src/enterprise/services/connectorCatalog/runtimeIntegration.ts:552-573`; `apps/server/src/enterprise/services/connectorCatalog/runtimeIntegration.ts:618-635`; `apps/server/src/enterprise/services/connectorCatalog/runtimeIntegration.ts:721-730`
- **Confidence:** HIGH
- **What:** `stableFailure` places values such as `PLATFORM_CONNECTOR_NOT_PUBLISHED` and `PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED` verbatim into both `content` and `error.message`.
- **Evidence:** All early denials and caught contract errors use `stableFailure`. The tool-execution caller returns this result directly to the chat runtime. Although localized connector feedback already exists for settings screens, this execution seam never invokes that presentation mapping.
- **Impact:** Users—and potentially the model receiving the tool result—see implementation identifiers instead of an actionable explanation. The codes also expose internal policy and credential-state terminology.
- **Fix:** Keep the stable code only in `error.code`; localize `content` and `error.message` at the tool-result presentation boundary. Suggested copy:

  - Unavailable — en-US: “This Connector is unavailable. Ask an administrator to publish or enable it, then try again.” zh-CN: “此 Connector 当前不可用。请联系管理员发布或启用后重试。”
  - Denied — en-US: “You don’t have permission to run this Connector tool. Ask an administrator to review its access settings.” zh-CN: “你没有运行此 Connector 工具的权限。请联系管理员检查访问设置。”
  - Missing credential — en-US: “This Connector is not fully configured. Ask an administrator to finish its setup.” zh-CN: “此 Connector 尚未完成配置。请联系管理员完成设置。”

### srv-connector-D7-2 — Expired OAuth authorization is presented as an invalid API key

- **Severity:** MEDIUM
- **Dimension:** D7 Overly technical/internal-state-leaking UI strings
- **Location:** `apps/server/src/services/oauthDeviceFlow/refresh.ts:109-115`
- **Confidence:** HIGH
- **What:** Irrecoverable refresh failures are classified as `InvalidProviderAPIKey`, even though the code comment and raw message instruct the user to reconnect OAuth.
- **Evidence:** `throwInvalidGrant` creates `AgentRuntimeErrorType.InvalidProviderAPIKey`. The conversation error presenter prefers the localized message for a typed error over the supplied raw message. Existing en-US and zh-CN localization for that type says the provider API key is incorrect or empty, so the reconnect instruction is discarded.
- **Impact:** Users are sent to troubleshoot or replace an API key that may not exist for the device-flow connection. The actual recovery action—reconnecting the provider—is hidden.
- **Fix:** Introduce or use a distinct OAuth-authorization-expired error type and localized presentation:

  - en-US: “Your connection to {{provider}} has expired. Reconnect it in Provider Settings, then try again.”
  - zh-CN: “你与 {{provider}} 的连接已过期。请在提供商设置中重新连接，然后重试。”

### srv-connector-D3-1 — Durable connection-test migration left no-op reset scaffolding in production exports

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/connectionTestState.ts:164-175`; `apps/server/src/enterprise/services/connectorCatalog/discoveryService.test.ts:12-30`; `apps/server/src/enterprise/services/connectorCatalog/discoveryService.test.ts:340`; `apps/server/src/enterprise/services/connectorCatalog/draftService.test.ts:24-39`; `apps/server/src/enterprise/services/connectorCatalog/publicationService.test.ts:25-40`; `apps/server/src/enterprise/services/connectorCatalog/publicationService.test.ts:224`
- **Confidence:** HIGH
- **What:** Two exported test-reset functions remain after the process-local connection-test cache was removed. Both are literal no-ops, but tests still invoke them as though they reset state.
- **Evidence:** `resetConnectorConnectionTestMemoryForTest` and `resetConnectorConnectionTestStateForTest` contain no behavior. A repository-wide reference search found callers only in the three listed test files.
- **Impact:** The API preserves a state model that no longer exists and makes test setup misleading: future maintainers may believe isolation depends on these calls.
- **Fix:** Delete both exports and their test call sites. Test isolation should explicitly clear the durable fixture rows when necessary.

### srv-connector-D4-1 — Invalid platform credential uploads emit untranslated English server prose

- **Severity:** LOW
- **Dimension:** D4 Missing Simplified Chinese i18n coverage
- **Location:** `apps/server/src/enterprise/services/platformGlobalCredentials/adminService.ts:238-249`
- **Confidence:** HIGH
- **What:** Non-canonical or empty base64 input throws the hardcoded English message `Invalid base64 file payload`.
- **Evidence:** The admin router forwards `PlatformGlobalCredentialValidationError.message` verbatim, and the platform credential file form displays an `Error.message` directly in its error toast. A locale search found no key or zh-CN translation for this text.
- **Impact:** Chinese-language administrators receive English implementation-oriented copy during an upload failure.
- **Fix:** Return a stable validation code and map it to localized copy:

  - en-US: “The file data is invalid. Select the file again and retry.”
  - zh-CN: “文件数据无效。请重新选择文件后重试。”

## Dimensions with no findings

- **D6 Warnings and errors not surfaced via toast:** In-scope user-action failures are returned or thrown as stable errors; swallowed catches are limited to best-effort cleanup, audit reconciliation, or background worker behavior. Toast/render ownership is outside these server service paths.
- **D8 Missing animations/motion:** The audited fork delta contains server-side services and tests only; it owns no panel, modal, list, loading, or state-transition UI where an upstream animation component or token could be applied.

## Cross-scope notes

- `apps/server/src/enterprise/services/connectorCatalog/OUT_OF_SCOPE_NEEDED.md:3-33` records that seven durable connection-test columns still lack a formal database migration. Production publish fails closed if those columns are absent.
- `apps/server/src/enterprise/services/connectorGovernance/OUT_OF_SCOPE_NEEDED.md:3-23` records a CRITICAL consumer gap in `toolExecution`/`aiAgent`: dynamically resolved builtin APIs, non-builtins, and unknown matrix entries can still bypass the synthesized fail-closed governance shape.
- The shared credentials UI has silent mutation paths outside this assignment: `CreateCredModal/KVCredForm.tsx`, `EditCredModal/EditKVForm.tsx`, and `EditCredModal/EditMetaForm.tsx` configure `useMutation` with `onSuccess` but no `onError` or rendered error state. Server validation failures can therefore leave submit actions with no toast or inline feedback.
