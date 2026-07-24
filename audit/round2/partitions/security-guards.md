# Partition: security-guards

## Summary

The partition is generally defensive around DNS pinning, authorization reconciliation, atomic rate limiting, and rewrap concurrency, but it has a concrete cloud-metadata SSRF bypass and several secret-redaction gaps. CRITICAL: 0 · HIGH: 3 · MEDIUM: 2 · LOW: 4.

## Findings

### F1 \[HIGH]\[D5] Alibaba Cloud metadata bypasses the permanent SSRF deny

- **Location:** `apps/server/src/enterprise/security/outboundHttp/policy.ts:74`, `apps/server/src/enterprise/security/outboundHttp/policy.ts:190`, `apps/server/src/enterprise/security/outboundHttp/policy.ts:410`, `apps/server/src/enterprise/security/outboundHttp/policy.ts:443`
- **Evidence:** `METADATA_IPV4` contains only three `169.254.*` addresses. After `isMetadataIp(normalized)` returns false, non-public-address filtering runs only when `policy.mode === 'public-only'`; `allow-private` then permits everything except recognized metadata. Alibaba ECS exposes instance metadata, including access credentials, at `100.100.100.200`, and documents token-free metadata access as an SSRF risk. [Alibaba Cloud ECS metadata documentation](https://www.alibabacloud.com/help/en/ecs/user-guide/view-instance-metadata/)
- **Impact / failure scenario:** On Alibaba ECS, an administrator or compromised connector-author account configures `http://100.100.100.200/latest/meta-data/ram/security-credentials/` under `allow-private`. The address passes every check and the pinned transport reaches IMDS, potentially disclosing RAM credentials.
- **Fix:** Add `100.100.100.200` to the permanent metadata denyset, audit other cloud-provider IMDS endpoints, and add direct-IP and DNS-resolution regression tests in every policy mode.
- **Confidence:** HIGH

### F2 \[HIGH]\[D5] Write-path redaction ignores known PEM, AWS, and Google secret shapes

- **Location:** `packages/database/src/models/platform/secretPatterns.ts:68`, `packages/database/src/models/platform/secretPatterns.ts:72`, `packages/database/src/models/platform/secretPatterns.ts:76`, `packages/database/src/models/platform/redact.ts:109`, `packages/database/src/models/platform/redact.ts:134`
- **Evidence:** Shared patterns define AWS access keys, Google API keys, and PEM private keys, but `containsSecretValueShape()` checks only `PREFIXED_SECRET_PATTERN`, `JWT_PATTERN`, and bearer values. `redactString()` therefore returns other recognized secret shapes unchanged.
- **Impact / failure scenario:** A non-sensitive field such as `{ note: "-----BEGIN PRIVATE KEY-----..." }` or `{ diagnostic: "AIza..." }` passes through `redactSensitive()` verbatim and can enter revision or audit payloads despite the module’s guarantee that secret material never does.
- **Fix:** Make the write-path detector consume the complete shared secret-pattern catalog, including PEM, AWS, and Google patterns. Add regression tests for each free-text shape and truncated PEM material.
- **Confidence:** HIGH

### F3 \[HIGH]\[D5] GitHub token detection covers only classic PATs

- **Location:** `packages/database/src/models/platform/secretPatterns.ts:56`, `packages/database/src/models/platform/secretPatterns.ts:59`, `packages/database/src/models/platform/auditCredentialMask.ts:127`
- **Evidence:** The GitHub alternative is only `ghp_[a-z0-9]{20,}`. GitHub documents additional live prefixes including `github_pat_`, `gho_`, `ghu_`, `ghs_`, and `ghr_`. [GitHub token-format documentation](https://docs.github.com/en/enterprise-cloud%40latest/authentication/keeping-your-account-and-data-secure/about-authentication-to-github)
- **Impact / failure scenario:** A fine-grained PAT embedded in free text is missed by `containsEnterpriseSecretMaterial`, `redactSensitive`, and `maskCredentialsInText`. It can consequently survive input validation and appear in persisted audits, revisions, or conversation evidence.
- **Fix:** Extend the shared GitHub pattern to all current token families and formats, then add detector, write-redaction, and audit-mask regression cases from the same fixture table.
- **Confidence:** HIGH

### F4 \[MEDIUM]\[D5] Secret-rotation recovery operations unnecessarily require valid Vault configuration

- **Location:** `apps/server/src/enterprise/services/secretRewrap/adminService.ts:21`, `apps/server/src/enterprise/services/secretRewrap/adminService.ts:66`, `apps/server/src/enterprise/services/secretRewrap/adminService.ts:113`, `apps/server/src/enterprise/services/secretRewrap/adminService.ts:124`, `apps/server/src/enterprise/services/secretRewrap/coordinator.ts:44`, `apps/server/src/enterprise/services/secretRewrap/coordinator.ts:56`, `apps/server/src/enterprise/services/secretRewrap/coordinator.ts:168`
- **Evidence:** Every service operation calls `createCoordinatorFromEnvironment()`, which rejects missing or invalid Vault configuration. The coordinator itself accepts no secret service, and only `enqueue()` requires one; `get()`, `list()`, and `cancel()` are database-only.
- **Impact / failure scenario:** If Vault configuration is removed or malformed while a rewrap job is pending or running, administrators cannot inspect or cancel the job—the exact recovery controls needed during a key-provider incident fail before reaching PostgreSQL.
- **Fix:** Construct an unconfigured coordinator for `get`, `list`, and `cancel`; initialize and validate the Vault-backed secret service only for operations that actually need cryptography.
- **Confidence:** HIGH

### F5 \[MEDIUM]\[D5] Malformed percent-encoding crashes audit credential masking

- **Location:** `packages/database/src/models/platform/auditCredentialMask.ts:102`, `packages/database/src/models/platform/auditCredentialMask.ts:106`, `packages/database/src/models/platform/auditCredentialMask.ts:109`, `packages/database/src/models/platform/auditCredentialMask.ts:141`
- **Evidence:** Each query key is passed directly to `decodeURIComponent(rawKey)` inside `replaceAll()` with no exception handling. Inputs such as `?%E0%A4%A=value` throw `URIError`.
- **Impact / failure scenario:** A user stores malformed URL-like text in a conversation. Admin conversation reads or exports encounter that text during masking and fail, potentially making an entire page or export job unavailable.
- **Fix:** Decode inside a guarded helper. On invalid encoding, fail closed by masking the candidate value or entire URL rather than throwing or returning it unchanged. Add a malformed-encoding regression test.
- **Confidence:** HIGH

### F6 \[LOW]\[D5] Responses exactly at the byte limit are falsely marked truncated

- **Location:** `apps/server/src/enterprise/security/outboundHttp/transport.ts:123`, `apps/server/src/enterprise/security/outboundHttp/transport.ts:125`, `apps/server/src/enterprise/security/outboundHttp/transport.ts:130`
- **Evidence:** The buffered transport truncates when `buf.length >= remaining`. Equality copies the complete final chunk but still sets `truncated = true` and destroys the connection.
- **Impact / failure scenario:** A valid JSON discovery, token, or connector response whose body is exactly `maxResponseBytes` is returned in full but reported as truncated; downstream callers reject it as an oversized or invalid response.
- **Fix:** Treat only `buf.length > remaining` as overflow. If equality fills the budget, wait for end or a subsequent non-empty chunk. Add exact-boundary and one-byte-over tests.
- **Confidence:** HIGH

### F7 \[LOW]\[D2] Rate-limit tests are wall-clock-coupled and one cleanup test never verifies cleanup

- **Location:** `packages/database/src/models/platform/adminMutationRate.pg.test.ts:59`, `packages/database/src/models/platform/adminMutationRate.pg.test.ts:64`, `packages/database/src/models/platform/adminMutationRate.pg.test.ts:112`, `packages/database/src/models/platform/adminMutationRate.pg.test.ts:124`, `packages/database/src/models/platform/adminMutationRate.pg.test.ts:287`, `packages/database/src/models/platform/adminMutationRate.pg.test.ts:395`, `apps/server/src/enterprise/security/rateLimit/adminMutationRateLimiter.pg.test.ts:71`, `apps/server/src/enterprise/security/rateLimit/adminMutationRateLimiter.pg.test.ts:90`, `apps/server/src/enterprise/security/rateLimit/adminMutationRateLimiter.pg.test.ts:93`
- **Evidence:** Tests use 30–50 ms windows, fixed `setTimeout(50|80|1100)` delays, and assume a concurrent cleanup query has reached a lock after 50 ms. The test named “runs bounded opportunistic cleanup” asserts only fresh-scope quota behavior; it never checks that stale rows were deleted or that deletion was bounded.
- **Impact / failure scenario:** Slow CI can cross a window boundary before an intended mid-window assertion, while fast or contended PostgreSQL can violate the assumed lock ordering. Cleanup can regress to a no-op and the named test still passes.
- **Fix:** **FIX** — move `window_start` deterministically with SQL, use an explicit database synchronization barrier for lock tests, and assert stale-row deletion plus the configured batch bound.
- **Confidence:** HIGH

### F8 \[LOW]\[D3] Dead placeholder catalog is retained solely for a source-text test

- **Location:** `packages/database/src/models/platform/redact.ts:55`, `packages/database/src/models/platform/redact.ts:59`, `packages/database/src/models/platform/redact.ts:80`, `apps/server/src/enterprise/security/redaction/detectSecretMaterial.test.ts:75`, `apps/server/src/enterprise/security/redaction/detectSecretMaterial.test.ts:80`
- **Evidence:** `DOCUMENTATION_PLACEHOLDER_MARKERS` is never used; `void DOCUMENTATION_PLACEHOLDER_MARKERS` suppresses that fact. Its comment says it is retained for a test, and that test reads source text merely to assert the identifier exists.
- **Impact / failure scenario:** The list implies behavior that does not exist and forces production code to retain inert data to satisfy an implementation-coupled test.
- **Fix:** Delete the marker list, the `void` expression, and the identifier-presence assertion. Preserve only behavioral and adversarial-performance tests.
- **Confidence:** HIGH

### F9 \[LOW]\[D3] Security posture documentation contradicts runtime behavior

- **Location:** `apps/server/src/enterprise/security/outboundHttp/RESIDUAL.md:15`, `apps/server/src/enterprise/security/outboundHttp/policy.ts:54`, `apps/server/src/enterprise/security/rateLimit/adminMutationRateLimiter.ts:125`, `apps/server/src/enterprise/guards/adminMutationRateLimit.ts:116`
- **Evidence:** `RESIDUAL.md` states “G-07 default allow-private,” while `DEFAULT_OUTBOUND_POLICY.mode` is `public-only`. The limiter comment says an unavailable limiter is fail-open and silently disables enforcement, while the middleware denies every decision other than `allowed`.
- **Impact / failure scenario:** Operators and reviewers can make incorrect deployment or incident-response decisions based on the documented posture, even though runtime currently behaves more restrictively.
- **Fix:** Correct the residual document to `public-only` and describe `unavailable` as an internal decision that the production guard handles fail-closed.
- **Confidence:** HIGH

## Dimension coverage

① Code smells — Checked long worker/provider/client flows, cleanup paths, query bounds, and duplication; no standalone D1 defect was confirmed.

② Test rot — F7 requires **FIX**; critical regressions should also be **ADD**ed for F1–F6.

③ Dead code & dev cruft — F8 and F9 cover the inert placeholder catalog, source-coupled test, and contradictory security documentation.

④ Missing zh-CN i18n — Clean; this partition exposes stable machine error codes and contains no confirmed untranslated user-facing copy.

⑤ Functional bugs — Issues cluster in metadata-address coverage, secret-pattern completeness, audit masking, rewrap recovery availability, and the buffered transport boundary.
