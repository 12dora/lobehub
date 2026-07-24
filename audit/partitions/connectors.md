## Partition: connectors

Scope reviewed: `apps/server/src/enterprise/services/{connectorCatalog,connectorGovernance}` and `src/enterprise/client/features/admin/connectors`
Files examined: 83 TypeScript/TSX files, 17,265 lines; notable areas include draft/publication services, OAuth lifecycle, runtime adapters, governance resolution, and the complete admin connector UI.

### Summary

The connector slice contains several high-impact state-machine and secret-handling defects. Governance fails open during read errors, allowing centrally denied tools or shared-auth requirements to be bypassed. The admin UI cannot complete its intended discover → test → publish flow because discovery and connection-test results are never persisted or retained. Secret redaction is generally deliberate, but custom header names, raw deterministic fingerprints, local draft recovery, and arbitrary exception messages create concrete disclosure paths. Tests cover many isolated components but currently codify two unsafe behaviors and do not exercise the complete admin workflow.

### Findings

#### \[CRITICAL] Governance read failures bypass organization connector policy

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/connectorGovernance/resolve.ts:10`
- **Problem:** Every governance read error is converted into inactive governance, which restores per-user/default behavior instead of preserving organization restrictions.
- **Evidence:** The implementation explicitly says `Fail-open to per-user behavior on any error` and returns `EMPTY_CONNECTOR_GOVERNANCE` from the catch block.
- **Impact / failure scenario:** If the database or governance cache fails while an organization has disabled a built-in tool or mandated a shared OAuth identity, runtime consumers see `active: false`. The denied tool can become available under the user's normal policy, or execution can use the user's OAuth binding instead of the governed shared identity.
- **Recommendation:** Fail closed for authorization-bearing fields. Retain a signed last-known-good snapshot where possible and otherwise deny governed tools/shared-auth substitutions until policy can be resolved. Replace the current test with `governance_read_failure_preserves_or_denies_org_policy`.

#### \[HIGH] Secret-bearing custom header names can escape runtime redaction

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/runtimeAdapter.ts:216`; `apps/server/src/enterprise/services/connectorCatalog/runtimeAdapter.ts:546`
- **Problem:** Runtime taint collection traverses object values but not object keys. Connector credentials explicitly support arbitrary custom header names, which the canonical contract treats as secret leaves.
- **Evidence:** `taintedValues.push(...collectSecretStrings(credential), ...Object.values(headers))`, while `collectSecretStrings` ends with `Object.values(value).flatMap(...)`. The contract’s `collectSecretLeafValues` separately treats both keys and values under `headers` as secret.
- **Impact / failure scenario:** Configure a shared credential with header `{ "opaque-private-name": "value" }`. If the remote connector echoes that name in a response key or message, `redactTaintedDeep` does not know it is tainted and can return or journal it unchanged.
- **Recommendation:** Use the canonical `collectConnectorSecretLeaves(credential)` collector for runtime taints, including dynamic keys and encoded variants. Add `runtime_response_redacts_custom_header_names_and_values`.

#### \[HIGH] Arbitrary edited secrets can be copied into localStorage

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/connectors/localDraftStorage.ts:86`; `src/enterprise/client/features/admin/connectors/useConnectorEditor.ts:59`; `src/enterprise/client/features/admin/connectors/localDraftStorage.test.ts:61`
- **Problem:** Local draft persistence scans only known credential patterns and suspicious field names; it is never given the secret currently being edited for exact-value comparison.
- **Evidence:** `saveAdminConnectorDraft` calls `carriesLocalDraftSecretMaterial(sanitized)` with no secret leaves. The existing regression uses only an AWS-shaped value: `AKIA1234567890ABCD99`.
- **Impact / failure scenario:** An admin enters `correct-horse-battery-staple` as a connector secret and also pastes it into the description. That arbitrary value matches no built-in pattern, so the public draft—including the plaintext description—is written to localStorage.
- **Recommendation:** Pass current replacement-secret leaves into the local scan and reject exact/contained matches, or suspend local persistence while a replacement secret is pending. Add `local_draft_rejects_arbitrary_current_secret_in_public_field`.

#### \[HIGH] Deterministic raw secret hashes provide an offline guessing oracle

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/platformConnectorSecretStore.ts:25`; `apps/server/src/enterprise/services/connectorCatalog/draftService.ts:185`; `apps/server/src/enterprise/services/connectorCatalog/catalogAudit.ts:43`; `apps/server/src/enterprise/services/connectorCatalog/catalogSnapshot.ts:216`
- **Problem:** Secret fingerprints are unkeyed SHA-256 hashes of predictable JSON and are exposed through admin projections and audit summaries.
- **Evidence:** `createHash('sha256').update(serialized).digest('hex')`; draft and published projections return `sharedSecretFingerprint`/`oauthClientSecretFingerprint`, and audit summaries persist them.
- **Impact / failure scenario:** A connector-read or audit-read administrator can brute-force a weak OAuth client secret or basic-auth password offline by hashing candidate JSON such as `"password"` or `{"password":"candidate"}` and comparing it with the exposed fingerprint.
- **Recommendation:** Replace externally visible fingerprints with keyed HMACs or random immutable version identifiers. Keep any integrity checksum internal to the secret service and migrate existing projections/audits away from raw hashes.

#### \[HIGH] Discover succeeds but its tools are immediately discarded

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/discoveryService.ts:86`; `src/enterprise/client/features/admin/connectors/useConnectorActions.tsx:91`; `src/enterprise/client/features/admin/connectors/useConnectorActions.tsx:170`; `src/enterprise/client/features/admin/connectors/openCreateConnectorModal.tsx:102`
- **Problem:** The server returns discovered tools without updating the draft, while the UI ignores the response, refetches the unchanged connector, and shows a success toast.
- **Evidence:** `discover` returns `{ oauthConfig, tools }` but performs no draft mutation. The UI's generic `run` does only `await operation(); await ... mutate()`. New-connector input contains no `tools`.
- **Impact / failure scenario:** Create a connector in the admin modal and click Discover. The remote tools are found and success is reported, but the editor remains empty. Publication then fails because preflight requires at least one enabled tool.
- **Recommendation:** Persist discovered tools server-side with revision/token CAS, or merge the response into the editor as a dirty draft requiring Save. Add `discover_populates_editor_and_can_be_saved_for_publication`.

#### \[HIGH] Successful connection tests never unlock Publish

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/discoveryService.ts:124`; `apps/server/src/enterprise/services/connectorCatalog/draftService.ts:142`; `src/enterprise/client/features/admin/connectors/controller.ts:159`; `src/enterprise/client/features/admin/connectors/useConnectorActions.tsx:339`
- **Problem:** Connection-test output is returned and audited but never stored. Every subsequent draft projection hardcodes `connectionTest: null`, while the UI requires a persisted current success before offering Publish.
- **Evidence:** `testConnection` returns `output` without updating the connector. `toDraft` sets `connectionTest: null`; primary-action selection passes `testPassed: isPersistedConnectorTestCurrent(data)`.
- **Impact / failure scenario:** An admin successfully tests a valid connector. The UI refetches, receives `connectionTest: null`, selects Test again as the primary action, and never renders Publish.
- **Recommendation:** Persist test status, tested revision, draft token, and timestamp atomically, or retain a validated result in UI state with well-defined invalidation. Add `successful_test_survives_refetch_and_unlocks_publish`.

#### \[HIGH] Governance mutations can commit while reporting failure

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/connectorGovernance/adminService.ts:124`
- **Problem:** The governance document commits before audit and invalidation. Failures in either later operation enter the common catch, append a failure audit, and rethrow despite the committed revision.
- **Evidence:** `model.publishGovernance(...)` runs at lines 133–137, followed by awaited audit and invalidation. Although invalidation is described as “Best-effort,” it has no local catch.
- **Impact / failure scenario:** Invalidation delivery fails after revision 12 commits and its success audit is written. The client receives an error and retries revision 11, which conflicts; audit history may contain both success and failure for a mutation that actually took effect.
- **Recommendation:** Couple mutation and audit transactionally or through an outbox. Catch invalidation failures as genuinely best-effort and report success once the authoritative commit succeeds. Add `invalidation_failure_does_not_reclassify_committed_governance_mutation`.

#### \[MEDIUM] Local restore silently changes clear/replace into keep

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/connectors/useConnectorEditor.ts:39`; `src/enterprise/client/features/admin/connectors/useConnectorEditor.ts:132`; `src/enterprise/client/features/admin/connectors/localDraftStorage.ts:12`
- **Problem:** Secret edit state is omitted from recovery storage, and hydration always resets it to `keep`, including non-secret `clear` intent.
- **Evidence:** Stored drafts contain only `baseRevision`, `draft`, `draftToken`, and `savedAt`; hydration executes `setSecret(createEmptyConnectorSecretEdit())`.
- **Impact / failure scenario:** An admin chooses Clear configured secret and edits another field, then reloads after a crash. The public draft is restored as dirty but the clear operation becomes keep; saving silently retains the credential the admin intended to remove.
- **Recommendation:** Persist safe operation metadata (`clear`, `keep`, or `replace_requires_reentry`) without secret bytes. Notify users when replacement input must be re-entered. Add `restored_clear_secret_intent_is_preserved`.

#### \[MEDIUM] Raw exception messages violate the publish secret boundary

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/catalogService.ts:168`
- **Problem:** The method promises that `publishError` never contains secrets but returns up to 500 characters of every non-contract `Error.message`.
- **Evidence:** `error instanceof Error ? error.message.slice(0, 500) : 'Publish failed'`.
- **Impact / failure scenario:** A database, lifecycle, vault, or outbound implementation throws an error containing a credential, header, internal URL, or query fragment. Immediate-create/update returns that text directly to the admin client.
- **Recommendation:** Return only allowlisted stable error codes and localized product messages. Log a sanitized error class/correlation ID server-side. Add `publish_error_does_not_echo_canary_secret_from_exception`.

#### \[MEDIUM] Losing CAS operations retain uncollectable replacement secrets

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/draftService.ts:543`; `apps/server/src/enterprise/services/connectorCatalog/platformConnectorSecretStore.ts:241`
- **Problem:** Replacement secrets are persisted before the locked CAS, but garbage collection excludes `oauthClientSecret` and `sharedSecret` handles.
- **Evidence:** The draft service acknowledges that a losing CAS “may leave an unreachable handle.” GC filters only `['oauthBindingToken', 'oauthPkceVerifier']` because platform client/shared versions are retained for rollback.
- **Impact / failure scenario:** Concurrent updates repeatedly lose CAS after persisting new shared credentials. Those encrypted rows are unreachable from any connector revision yet remain indefinitely, increasing retained sensitive material and storage.
- **Recommendation:** Revoke the newly created handle on CAS failure after confirming it is unreferenced, or extend GC to identify client/shared refs absent from both live connectors and revision history. Add `losing_CAS_revokes_unreferenced_replacement_secret`.

#### \[MEDIUM] A crashed OAuth refresh leaves a permanent lease

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/userOAuthService.ts:345`; `apps/server/src/enterprise/services/connectorCatalog/userOAuthService.ts:412`
- **Problem:** Refresh jobs receive a lease until year 9999 and can only be reclaimed from `dead` or `failed`, not from abandoned `running` state.
- **Evidence:** `leaseUntil: timestamptz '9999-12-31...'`; reclaim predicate is `inArray(platformJobs.status, ['dead', 'failed'])`.
- **Impact / failure scenario:** The process dies after acquiring the lease but before completing/failing the job. The binding revision never changes, every later refresh uses the same idempotency key, cannot reclaim the running job, and fails with `PLATFORM_CONNECTOR_RESOURCE_MISMATCH` until manual database repair.
- **Recommendation:** Use finite leases with heartbeat/expiry-based reclamation. Preserve rotating-token safety by recording whether outbound refresh started and handling ambiguous attempts explicitly. Add `expired_running_refresh_lease_can_be_recovered_after_crash`.

#### \[MEDIUM] Readiness and catalog listing issue large query fan-outs

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/runtimeReadiness.ts:50`; `apps/server/src/enterprise/services/connectorCatalog/userOAuthService.ts:158`
- **Problem:** Readiness loads each of up to 10,000 connectors serially and resolves its secret separately. User catalog listing performs two additional reads for every returned connector.
- **Evidence:** Readiness contains `for (const listed of page.items) { await read.getSnapshot(...) ... await resolveConnectorSecretVersion(...) }`. `listManaged` maps every item to `getPublicPublished` plus `getBinding`.
- **Impact / failure scenario:** A large tenant can trigger thousands of serial database/decryption calls during readiness, delaying startup or health responses. A 100-item user page creates approximately 201 repository operations and unnecessary database load.
- **Recommendation:** Batch published snapshots, secret metadata, and user bindings. Add bounded query-count tests for 100 and 10,000 connector fixtures.

#### \[MEDIUM] Tests codify unsafe fail-open and orphan-retention behavior

- **Dimension:** 2 / Test rot
- **Location:** `apps/server/src/enterprise/services/connectorGovernance/service.test.ts:156`; `apps/server/src/enterprise/services/connectorCatalog/draftService.test.ts:239`
- **Problem:** Tests explicitly assert the two unsafe semantics rather than protecting the desired security invariants.
- **Evidence:** Test names are `fail-opens to the per-user default...` and `leaves a safe orphan after a losing CAS`; the latter verifies that the orphan remains resolvable.
- **Impact / failure scenario:** Correctly changing governance to fail closed or cleaning up a losing-CAS secret appears as a regression in CI, encouraging preservation of the vulnerabilities.
- **Recommendation:** Replace them with `governance_read_failure_denies_or_uses_last_known_policy` and `losing_CAS_cleans_unreferenced_secret`. Add the discover/save and test/publish workflow regressions named above; no `.skip`, `.todo`, or `xit` tests were found.

#### \[MEDIUM] Audit actions and tombstone descriptions bypass zh-CN localization

- **Dimension:** 4 / Missing simplified-Chinese i18n
- **Location:** `src/enterprise/client/features/admin/connectors/ConnectorAuditPanel.tsx:75`; `apps/server/src/enterprise/services/connectorCatalog/runtimeIntegration.ts:307`
- **Problem:** The audit UI renders raw procedure identifiers, and tombstone tool metadata embeds an English sentence.
- **Evidence:** `<Text strong>{row.action}</Text>` and `description: 'Managed Connector is unavailable'`. Locale files contain translated audit results but no translations for connector action identifiers or this tombstone description.
- **Impact / failure scenario:** A zh-CN administrator sees strings such as `admin.connectors.updateDraft`; Chinese users encountering a removed managed connector see an English availability message.
- **Recommendation:** Map audit action codes to `connectorCatalog.audit.action.*` keys in both default and `zh-CN` locales. Represent tombstone status with a stable message code and localize it at the presentation boundary.

#### \[LOW] Four in-scope exports are unused repository-wide

- **Dimension:** 3 / Dead code and dev cruft
- **Location:** `src/enterprise/client/features/admin/connectors/controller.ts:135`; `src/enterprise/client/features/admin/connectors/types.ts:93`; `apps/server/src/enterprise/services/connectorCatalog/publishedIndex.ts:155`
- **Problem:** Repository-wide searches found no consumers beyond the declarations themselves.
- **Evidence:** The unused symbols are `fingerprintEditableAdminConnectorDraft`, `ConnectorOAuthClientSecretMutation`, `ConnectorSharedSecretMutation`, and `MAX_CONNECTOR_PUBLISHED_INDEX_ENTRIES`.
- **Impact / failure scenario:** These exports imply supported APIs or safety mechanisms that do not exist in actual execution, increasing maintenance and review ambiguity.
- **Recommendation:** Remove them, or wire the draft fingerprint into an explicitly designed comparison mechanism if it is still required.

#### \[LOW] OAuth service test file exceeds the repository size guideline

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/services/connectorCatalog/userOAuthService.test.ts:1`
- **Problem:** The test file is 895 lines, exceeding the repository’s approximately 800-line file guideline.
- **Evidence:** `wc -l` reports 895 lines, making it the largest file in the partition.
- **Impact / failure scenario:** Authorization, callback, refresh, concurrency, cleanup, and historical-revision behavior are coupled into one suite, making fixtures harder to reason about and future failures slower to isolate.
- **Recommendation:** Split it into authorization/callback, refresh/concurrency, and cleanup/revision-history suites with shared typed fixtures.

### Metrics

- Total findings: 16 (CRITICAL 1, HIGH 6, MEDIUM 7, LOW 2)
- Largest in-scope files (lines): `userOAuthService.test.ts` 895; `publicationService.ts` 743; `runtimeIntegration.ts` 737
- Dead-code candidates verified unused repo-wide: 4
