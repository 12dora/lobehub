## Partition: security-guards

Scope reviewed: `apps/server/src/enterprise/security/**` and `apps/server/src/enterprise/guards/**`
Files examined: 60 TypeScript files, including authorization registries, managed-resource guards, outbound HTTP policy, Better Auth blocking, redaction, rate limiting, and secret providers

### Summary

The admin dual registries currently reconcile all 188 live admin procedures and all 103 mutations in both directions; no missing security- or policy-registry entry was found. The largest risks are deliberate fail-open behavior during managed-catalog outages, unrestricted private-network access in the default outbound policy, and allowing Vault credentials over remote plaintext HTTP. The Better Auth endpoint denylist also contains a stale pathname that leaves a real installed admin endpoint reachable. Redaction coverage is generally conservative, but guard audit attribution, regression-test strength, i18n, and oversized registry files need improvement.

### Findings

#### \[HIGH] Enforced managed-resource policies fail open during catalog outages

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/guards/managedResource.ts:128`; `apps/server/src/enterprise/guards/managedResource.test.ts:190`
- **Problem:** An enforced, published managed-resource policy permits legacy mutations when runtime readiness becomes false for AI providers, AI models, connectors, or agents. Only Skills remain fail-closed.
- **Evidence:** The guard detects `policy.managed && policy.enforcementMode === 'enforced' && mode === 'unmanaged' && !resolved.readiness[...]`, records `catalog_not_ready`, and then executes `return;`. The regression test explicitly expects this call to resolve for every resource except `skills` at lines 204–212.
- **Impact / failure scenario:** An administrator publishes enforced management while the catalog is healthy. Later, a readiness probe fails during an outage or restart. During that window an ordinary user can invoke legacy procedures such as provider creation, connector definition updates, or agent mutations even though the published policy still says they are centrally managed.
- **Recommendation:** Once an enforced policy has been published, deny guarded mutations whenever readiness is false for every resource, as already done for Skills. Preserve observability through a distinct `catalog_not_ready` denial reason and replace the current allow assertions with fail-closed regression tests.

#### \[HIGH] Default outbound policy exposes the entire private network

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/security/outboundHttp/policy.ts:53`; `apps/server/src/enterprise/security/outboundHttp/policy.ts:399`; `apps/server/src/enterprise/security/outboundHttp/safeOutboundHttpClient.ts:59`
- **Problem:** Constructing `SafeOutboundHttpClient` without explicit policy opts into `allow-private`, under which loopback, RFC1918, link-local, and other internal addresses are allowed except for a small metadata denylist.
- **Evidence:** `DEFAULT_OUTBOUND_POLICY` sets `mode: 'allow-private'`, and `assertResolvedIpAllowed` ends with `// allow-private: public + private OK`. Repo-wide verification found production default construction in the AI provider connection-test path and policy-provider construction for connector/MCP traffic. The test at `safeOutboundHttpClient.test.ts:247` expressly asserts localhost is allowed by default.
- **Impact / failure scenario:** A user with access to configure or exercise an outbound provider/connector supplies `http://127.0.0.1:...`, a Kubernetes service address, or an RFC1918 administration endpoint. The server resolves, pins, and connects to that internal service, enabling SSRF discovery or interaction from the server’s network position.
- **Recommendation:** Make `public-only` the generic default. Require explicit, deployment-scoped opt-in for private access, preferably through exact host/IP allowlisting. Add regression tests proving default constructors reject loopback, RFC1918, link-local, and private DNS results.

#### \[HIGH] Vault tokens and AppRole secrets may be sent over remote plaintext HTTP

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/security/secret/keyProviders/vaultKeyProvider.ts:149`; `apps/server/src/enterprise/security/secret/keyProviders/vaultKeyProvider.ts:572`
- **Problem:** Vault address validation permits both HTTP and HTTPS for any hostname. Subsequent requests put `X-Vault-Token` or AppRole credentials on that connection.
- **Evidence:** `validateAddress` accepts `['http:', 'https:']`, while `request()` sets `headers['X-Vault-Token'] = token` and sends AppRole login bodies through the configured origin. Tests reject URL-embedded credentials but do not reject non-loopback HTTP.
- **Impact / failure scenario:** An operator configures `VAULT_ADDR=http://vault.internal:8200`. A network observer or compromised proxy can capture the Vault token or AppRole SecretID, retrieve current and historical KEKs, and decrypt enterprise secrets.
- **Recommendation:** Require HTTPS except for explicit loopback development addresses such as `127.0.0.1`, `::1`, or `localhost`. If remote HTTP must exist for development, gate it behind a clearly named unsafe flag that defaults off. Add tests for remote-HTTP rejection and loopback-only allowance.

#### \[MEDIUM] Stale Better Auth pathname leaves a real admin endpoint unblocked

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/security/betterAuthAdminBlock.ts:8`; `apps/server/src/enterprise/security/betterAuthAdminBlock.test.ts:22`
- **Problem:** The denylist contains `/admin/user-has-permission`, but Better Auth 1.6.15 exposes the endpoint as `/admin/has-permission`.
- **Evidence:** The in-scope list declares `'/admin/user-has-permission'`. Repo-wide dependency inspection found `createAuthEndpoint("/admin/has-permission", ...)` and no `/admin/user-has-permission` endpoint. The “lists every” test checks only a hand-picked subset and misses this mismatch.
- **Impact / failure scenario:** With platform administration enabled, a request to `/api/auth/admin/has-permission` bypasses `maybeBlockBetterAuthAdminMutation` and reaches the Better Auth admin plugin, despite the stated policy that platform RBAC is the sole administration surface.
- **Recommendation:** Replace the stale path with `/admin/has-permission`. Add a reconciliation test against the installed Better Auth admin endpoint inventory or, at minimum, an explicit test for every dependency endpoint so future renames cannot silently reopen a path.

#### \[MEDIUM] Managed-resource guard audits discard actor attribution

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/guards/managedResource.ts:29`; `apps/server/src/enterprise/guards/managedResource.ts:57`; `apps/server/src/enterprise/guards/managedResource.ts:100`
- **Problem:** The guard accepts a principal but deliberately ignores it, always writing `actorUserId: null`. Observe-mode violations are additionally recorded with `result: 'success'`.
- **Evidence:** The parameter comment says `principal` is ignored; `appendGuardAuditBestEffort` hardcodes `actorUserId: null`, and maps `would_deny` to `result: 'success'`. Middleware already has the trusted `ctx.userId` at line 253.
- **Impact / failure scenario:** Multiple users probe or violate centrally managed resource policy. Audit records show the targeted procedure and resource but cannot identify the actor, and observe-mode attempts look successful in result-based audit queries, frustrating incident response and policy rollout analysis.
- **Recommendation:** Pass the trusted principal ID into the audit row, without including raw request input. Use a non-success result or a dedicated outcome field for `would_deny`, and add tests asserting actor attribution and unambiguous result semantics.

#### \[MEDIUM] Managed-resource registry coverage can pass without an attached guard

- **Dimension:** 2 / Test rot
- **Location:** `apps/server/src/enterprise/guards/managedResourceMutationRegistry.test.ts:40`; `apps/server/src/enterprise/guards/managedResourceMutationRegistry.test.ts:50`; `apps/server/src/enterprise/guards/managedResourceRealRouters.test.ts:183`
- **Problem:** The test claiming every mutation is wired “exactly once” only searches the entire source file for a matching text fragment. It neither verifies attachment to the corresponding final tRPC procedure nor verifies exactly one occurrence. The real-router suite invokes only representative writes rather than all registered procedures.
- **Evidence:** Coverage is `source.includes("withManagedResourceGuard('<procedure>')")`, while the fixed registry assertion expects 99 entries. A detached helper, dead constant, or comment containing the same string would satisfy the test after the actual middleware was removed. Other stale test titles still refer to “71” mutations although the live count is 103.
- **Impact / failure scenario:** A refactor removes a guard from a live mutation but leaves the same text elsewhere in the router file. CI remains green and the legacy write becomes available under an enforced managed policy.
- **Recommendation:** Attach private metadata to `withManagedResourceGuard`, then inspect each live final procedure’s middleware chain, mirroring the admin authorization reconciliation tests. Add negative controls for detached/comment-only guard strings and invoke every deny/input-sensitive procedure through a generated caller matrix.

#### \[LOW] Client-visible guard errors are hardcoded in English

- **Dimension:** 4 / Missing simplified-Chinese i18n
- **Location:** `apps/server/src/enterprise/guards/managedPlatformAgent.ts:11`; `apps/server/src/enterprise/guards/managedPlatformAgent.ts:74`; `apps/server/src/enterprise/security/betterAuthAdminBlock.ts:63`
- **Problem:** Managed-agent denials, oversized-batch errors, and the Better Auth block response contain raw English messages rather than stable translated error contracts.
- **Evidence:** Examples include `"This agent is managed by your organization and cannot be modified here."`, `` `A maximum of ${MAX_MANAGED_AGENT_GUARD_IDS} agents...` ``, and `"Better Auth admin mutations are disabled..."`. Repo-wide searches found no matching keys in `packages/locales/src/default/` or `locales/zh-CN/`.
- **Impact / failure scenario:** A zh-CN user encountering these guards receives English fallback text from the API or generic error renderer.
- **Recommendation:** Return stable enterprise error codes and translate them in the client error mapper. Add English source keys and hand-authored zh-CN translations, including interpolation for the batch limit.

#### \[LOW] Registry and test files exceed the repository size guideline

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/security/policy/adminProcedureAuthorizationRegistry.ts:1`; `apps/server/src/enterprise/security/policy/adminMutationRegistry.ts:1`; `apps/server/src/enterprise/security/outboundHttp/safeOutboundHttpClient.test.ts:1`
- **Problem:** Three in-scope files exceed the repository’s approximately 800-line file-size threshold, with large hand-maintained catalogs and a monolithic HTTP test suite.
- **Evidence:** Line counts are 1,087, 816, and 971 respectively.
- **Impact / failure scenario:** Reviewers must reason across very large parallel registries, increasing the chance of permission drift or overlooked policy changes; unrelated outbound behaviors are also coupled into one test file.
- **Recommendation:** Split both registries by admin router/domain and combine their typed fragments into a single exported catalog. Split outbound tests into policy, redirects, streaming, transport limits, and observability suites while retaining reconciliation tests over the combined result.

#### \[LOW] Completed M07 work remains labeled as a TODO

- **Dimension:** 3 / Dead code & dev cruft
- **Location:** `apps/server/src/enterprise/security/redaction/types.ts:7`; `apps/server/src/enterprise/security/redaction/redact.ts:87`
- **Problem:** `RedactOptions.isBenignKey` is still documented as `TODO(M07)` even though the M07 allowlist and production consumers are implemented.
- **Evidence:** The type comment says `TODO(M07): benign allowlist`, while the same module exports `M07_REDACTION_OPTIONS`, and repo-wide callers use it in AI-catalog contracts, persistent text, and publication paths.
- **Impact / failure scenario:** Future maintainers may treat a completed security-sensitive redaction exception as unfinished or attempt a redundant redesign.
- **Recommendation:** Remove the stale TODO and document the current narrow M07 contract and its production consumers.

### Metrics

- Total findings: 9 (CRITICAL 0, HIGH 3, MEDIUM 3, LOW 3)
- Largest in-scope files (lines): `adminProcedureAuthorizationRegistry.ts` 1,087; `safeOutboundHttpClient.test.ts` 971; `adminMutationRegistry.ts` 816
- Dead-code candidates verified unused repo-wide: 0
