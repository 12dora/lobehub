## Partition: identity

Scope reviewed: `apps/server/src/enterprise/services/identityProvider`, `src/enterprise/client/features/admin/identityProviders`, `src/enterprise/client/features/admin/securityAuth`, and `src/enterprise/client/features/admin/reauth`
Files examined: 64 TypeScript/TSX files, approximately 13,795 lines

### Summary

The identity slice has solid secret redaction, feature-flag isolation, and complete dual-registry coverage for its admin procedures. Its largest risk is provider lifecycle management: a published provider cannot be individually revoked, and the last-known-good convergence logic rejects provider removal. The isolated login test also diverges materially from production validation, while RFC 9207 response-issuer verification is absent from that flow. Additional operational risks include broken secret rotation on non-draft providers, truncated provider lists, delayed restart-failure reporting, and unbounded startup queries.

### Findings

#### \[CRITICAL] Published identity providers cannot be individually revoked

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/identityProvider/adminService.ts:248`, `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:94`, `apps/server/src/enterprise/services/identityProvider/lkg.ts:295`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:29`
- **Problem:** Deletion requires a draft provider and explicitly rejects any provider with a published revision. Published payloads are always enabled, startup always selects the latest published revision, and LKG comparison rejects snapshots that remove an existing provider. The admin UI exposes neither disable nor removal.
- **Evidence:** `requireDraft(...)`; `throw new Error('PLATFORM_IDENTITY_PROVIDER_HAS_PUBLISHED_REVISION')`; published payload construction sets `enabled: true`; `if (!nextProvider) return 'rejected'`.
- **Impact / failure scenario:** If an OIDC client secret, upstream IdP, or provider configuration is compromised, an administrator cannot revoke only that provider. Even a future database-side removal can be rejected by convergence and resurrected from LKG during an outage. The only effective switch is disabling all database-backed identity providers.
- **Recommendation:** Add a reauth-protected, dual-registry disable/archive operation that publishes a signed removal or tombstone revision. Make startup selection honor it, permit authenticated monotonic removals in LKG comparison, expose a destructive confirmation UI, and add compromise-revocation and outage-fallback regression tests.

#### \[HIGH] Secret replacement and clearing fail on active providers

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/identityProvider/adminService.ts:175`, `apps/server/src/enterprise/services/identityProvider/secretStore.ts:115`, `apps/server/src/enterprise/services/identityProvider/secretStore.ts:164`, `apps/server/src/enterprise/services/identityProvider/adminService.test.ts:88`
- **Problem:** The outer update remembers the provider’s original status, but `persistSecret` and `clearSecret` independently change that status to `draft`. The subsequent CAS update still requires `status = before.status`.
- **Evidence:** The outer predicate uses `revision = nextRevision` and `status = before.status`, while both secret mutations execute `status: 'draft'`.
- **Impact / failure scenario:** Replacing or revoking the secret of an `active`, `published`, or `pending_restart` provider updates it to draft inside the transaction, then matches zero rows and reports a revision conflict. The transaction rolls back, blocking urgent credential rotation. Existing tests cover only `secret: keep` on a draft.
- **Recommendation:** Perform lifecycle, revision, and secret-reference changes in one locked mutation, or stop the secret store from independently changing provider status. Add replace-and-clear tests for active and pending-restart providers.

#### \[HIGH] RFC 9207 authorization-response issuer is ignored

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/identityProvider/discoveryValidator.ts:61`, `apps/server/src/enterprise/services/identityProvider/testFlowService.ts:322`
- **Problem:** Discovery parsing drops `authorization_response_iss_parameter_supported`, and the isolated OAuth callback accepts only `code`, origin, and state. It never receives or verifies the authorization response’s `iss` parameter.
- **Evidence:** `toMetadata` omits the RFC 9207 capability; callback processing destructures `{ code, effectiveOrigin, state }` and proceeds directly to token exchange after origin/state checks.
- **Impact / failure scenario:** A provider advertising RFC 9207 can return a missing or mismatched response issuer without the test flow rejecting it at the authorization-response boundary. A mix-up or misrouted response proceeds to the configured token endpoint and may fail only indirectly.
- **Recommendation:** Preserve the discovery capability, pass `iss` through the callback boundary, reject any present mismatch, and require an exact issuer when the provider advertises support. Add correct, missing, and mismatched issuer tests.

#### \[HIGH] Safe-login tests approve configurations rejected by production

- **Dimension:** 2 / Test rot
- **Location:** `apps/server/src/enterprise/services/identityProvider/testFlowService.ts:57`, `apps/server/src/enterprise/services/identityProvider/testFlowService.ts:397`, `apps/server/src/enterprise/services/identityProvider/publicationService.ts:922`, `apps/server/src/enterprise/services/identityProvider/testFlowService.test.ts:36`
- **Problem:** The isolated claim preview validates subject and name but neither requires email nor applies the provider’s email-domain allowlist. Publication treats that result as authoritative. A test explicitly codifies success without an email claim.
- **Evidence:** `buildIdentityProviderClaimPreview` has no `domainAllowlist` input; the test supplies only `employee_name` and `employee_subject` and expects `valid: true`.
- **Impact / failure scenario:** An administrator receives a successful test, publishes, and restarts. Real users then fail production login because the production adapter requires a valid, allowed email, potentially causing a complete authentication outage.
- **Recommendation:** Share a pure profile-validation function with production, including email syntax and domain-allowlist checks. Replace the stale success assertion and add missing-email, malformed-email, allowed-domain, and denied-domain publication regressions.

#### \[HIGH] Group-to-role mapping is published but never enforced

- **Dimension:** 3 / Dead code and development cruft
- **Location:** `src/enterprise/client/features/admin/identityProviders/steps/PolicyStep.tsx:48`, `apps/server/src/enterprise/services/identityProvider/publicationService.ts:226`
- **Problem:** The UI presents `groupRoleMapping` as an authorization policy and publication persists it, but repo-wide usage contains no login/runtime consumer. The claim-mapping contract also has no groups claim.
- **Evidence:** The UI labels the field “Group-to-role mapping”; the published payload includes `groupRoleMapping`; repo-wide references are limited to schemas, persistence, tests, and admin UI.
- **Impact / failure scenario:** An administrator maps an IdP group to a privileged or restricted platform role and assumes it is enforced. Login never evaluates the mapping, leaving users with their default or existing roles and silently violating the configured authorization policy.
- **Recommendation:** Either implement group-claim extraction and transactional role reconciliation with explicit escalation rules, or remove the field from UI/contracts until supported. Add end-to-end authorization tests before exposing it again.

#### \[MEDIUM] Provider list silently truncates after 100 records

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/identityProviders/hooks/useIdentityProviders.ts:8`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:203`, `apps/server/src/enterprise/services/identityProvider/adminService.test.ts:128`
- **Problem:** The client always requests `limit: 100`, ignores `nextCursor`, and renders the table with pagination disabled.
- **Evidence:** `list({ limit: 100 })`; `dataSource={items}`; `pagination={false}`. The server test confirms a 101st record requires cursor traversal.
- **Impact / failure scenario:** With more than 100 providers, later providers disappear from administration and cannot be selected for editing, testing, or publication.
- **Recommendation:** Implement cursor pagination or incremental loading, preserve `nextCursor`, and add a UI regression using at least 101 providers.

#### \[MEDIUM] Known restart-scheduling failures remain hidden until timeout

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/identityProvider/systemService.ts:657`, `apps/server/src/enterprise/services/identityProvider/systemService.ts:149`, `src/enterprise/client/features/admin/identityProviders/restart/controller.ts:203`
- **Problem:** Restart scheduling failures are persisted but swallowed after acceptance. Snapshot status does not expose restart-request failure state, and the client controller waits only for activation, mismatch, unsupported state, or deadline expiry.
- **Evidence:** `signalAcceptedRestart` catches scheduling errors and records failure without rethrowing; `getAuthSnapshotStatus` does not return the accepted request’s status; the controller ignores query errors while polling.
- **Impact / failure scenario:** If the supervisor immediately rejects or fails to schedule a restart, the administrator sees reconnecting progress for roughly two minutes before receiving a generic failure, delaying recovery and obscuring the real cause.
- **Recommendation:** Include request ID, status, and result category in convergence status and transition the UI immediately on terminal failure. Surface initial polling errors with retry guidance and add schedule-failure controller tests.

#### \[MEDIUM] Startup loads unbounded revision and secret history

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:98`, `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:127`, `apps/server/src/enterprise/services/identityProvider/startupSnapshot.ts:176`
- **Problem:** Startup selects every published revision, deduplicates the latest revision in JavaScript, then loads all unrevoked secret versions for the selected providers and searches them in memory.
- **Evidence:** The revision query has no per-resource limit or window; `seenResourceIds` performs client-side deduplication; secret resolution uses an unrestricted query followed by `.find(...)`.
- **Impact / failure scenario:** Long-lived installations accumulate revision and rotation history indefinitely. Every restart transfers and parses the complete history, causing progressively slower boot, greater memory use, and eventual startup timeouts.
- **Recommendation:** Use `DISTINCT ON` or a window query for the latest published revision per resource, and join the exact secret reference/fingerprint needed by that revision. Add supporting indexes and a large-history query-plan regression.

#### \[MEDIUM] Publication service exceeds the repository size guideline

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/services/identityProvider/publicationService.ts:1`, `apps/server/src/enterprise/services/identityProvider/publicationService.test.ts:1`
- **Problem:** The production file is 1,236 lines and its test is 1,174 lines, both well above the repository’s approximately 800-line guideline. The service combines payload parsing, idempotency leases, audit handling, publication, rollback, and observability.
- **Evidence:** Line counts are 1,236 and 1,174 respectively, with multiple independent responsibilities and transaction protocols in one module.
- **Impact / failure scenario:** Security-sensitive lifecycle changes require modifying a highly coupled file, increasing regression risk and making transaction and idempotency invariants difficult to review.
- **Recommendation:** Extract payload validation, idempotency/lease persistence, publish orchestration, rollback orchestration, and observability into focused modules with corresponding test suites.

#### \[LOW] Reauthentication popup has no overall timeout

- **Dimension:** 1 / Code smells
- **Location:** `src/enterprise/client/features/admin/reauth/requestAdminReauth.ts:97`, `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:79`
- **Problem:** The popup promise cleans up on a completion message, abort signal, or detected popup closure, but has no maximum lifetime. Callers do not provide an abort signal.
- **Evidence:** A message listener and polling interval are installed, but no deadline timer exists around `requestAdminReauth({ authMethod })`.
- **Impact / failure scenario:** If the popup remains open on a stalled or unexpected page, the admin action stays pending indefinitely and retains its event listener and interval until the popup is manually closed.
- **Recommendation:** Add a default timeout, close the popup, run cleanup, and return a localized retryable error. Cover it with fake-timer tests.

#### \[LOW] Discovery validation performs redundant outbound requests

- **Dimension:** 1 / Code smells
- **Location:** `src/enterprise/client/features/admin/identityProviders/IdentityProviderWizard.tsx:305`, `apps/server/src/enterprise/services/identityProvider/discoveryValidator.ts:95`
- **Problem:** The wizard concurrently calls discovery and network validation, although discovery already fetches the document and preflights all advertised endpoints. Network validation preflights the discovery URL again.
- **Evidence:** `Promise.all([discover(...), validateNetwork(...)])`; discovery itself validates the discovery URL plus authorization, token, userinfo, and JWKS endpoints.
- **Impact / failure scenario:** Each validation click creates avoidable duplicate outbound traffic and audit entries. Intermittent network behavior can also produce confusing partial success between two overlapping checks.
- **Recommendation:** Make discovery return the consolidated network-validation result and remove the redundant client call, or clearly separate non-overlapping validation responsibilities.

#### \[LOW] Revision label bypasses localization

- **Dimension:** 4 / Missing Simplified-Chinese i18n
- **Location:** `src/enterprise/client/features/admin/identityProviders/steps/PublishStep.tsx:64`
- **Problem:** The rollback revision option renders a hardcoded English abbreviation instead of using `react-i18next`.
- **Evidence:** `` `rev ${item.revision} · ${item.publishedAt.toLocaleString()}` ``.
- **Impact / failure scenario:** A zh-CN administrator sees English “rev” embedded in an otherwise translated publication workflow.
- **Recommendation:** Add an `identityProviders.rollback.revisionOption` key to the English source and hand-authored zh-CN locale, interpolating the revision and localized publication time.

#### \[LOW] Production-unused identity-provider abstractions remain exported

- **Dimension:** 3 / Dead code and development cruft
- **Location:** `apps/server/src/enterprise/services/identityProvider/factory.ts:10`, `apps/server/src/enterprise/services/identityProvider/systemService.ts:683`
- **Problem:** The security-foundation factory abstraction is referenced only by its own tests, while runtime construction bypasses it. `IdentityProviderAuthSnapshotStatus` is also declared but unused repo-wide.
- **Evidence:** Repo-wide symbol searches found no production callers of `createIdentityProviderSecurityFoundation` and no references to `IdentityProviderAuthSnapshotStatus` beyond their declarations/tests.
- **Impact / failure scenario:** The unused factory suggests a canonical construction path that production does not follow, encouraging tests or future changes to validate the wrong integration seam.
- **Recommendation:** Delete the factory abstraction, its isolated tests, and the unused type, or make the factory the actual runtime construction path and test that wiring.

### Metrics

- Total findings: 13 (CRITICAL 1, HIGH 4, MEDIUM 4, LOW 4)
- Largest in-scope files (lines): `publicationService.ts` (1,236), `publicationService.test.ts` (1,174), `systemService.ts` (683)
- Dead-code candidates verified unused repo-wide: 2
