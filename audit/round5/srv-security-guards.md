# Round 5 Audit — srv-security-guards

## Scope

Audited all fork-owned files under:

- `apps/server/src/enterprise/security`
- `apps/server/src/enterprise/guards`

The baseline diff contains 81 added files and 14,321 inserted lines. Because every scoped file is fork-added, there were no byte-identical upstream files or upstream fork seams to exclude. Callers and installed Better Auth code were inspected only to verify scoped behavior.

Round-4 remediation commit `4f68061410` was reviewed as a prime suspect. No write-capable checks were run; validation used diffs, full source/test inspection, repo-wide searches, and read-only runtime probes.

## Summary

| Dimension                           | Findings | Highest severity |
| ----------------------------------- | -------: | ---------------- |
| D1 Code smells                      |        1 | MEDIUM           |
| D2 Test decay                       |        1 | MEDIUM           |
| D3 Dead code and development debris |        2 | LOW              |
| D4 Missing Simplified Chinese i18n  |        0 | —                |
| D5 Potential functional bugs        |        3 | HIGH             |
| D6 Errors not surfaced via toast    |        0 | —                |
| D7 Technical/internal UI strings    |        0 | —                |
| D8 Missing animations/motion        |        0 | —                |

## Findings

### srv-security-guards-D5-001 — Fetch adapter throws on valid bodyless HTTP responses

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/security/outboundHttp/safeOutboundFetchAdapter.ts:298-304`; `apps/server/src/enterprise/security/outboundHttp/transport.ts:14,261-272`
- **Confidence:** HIGH
- **What:** The fetch-compatible adapter always gives the `Response` constructor a non-null `Uint8Array` body. The Fetch implementation forbids a body for HTTP 204, 205, and 304 responses, even when that array is empty.
- **Evidence:** The adapter constructs `new Response(new Uint8Array(response.body), { status: response.status })` unconditionally. The streaming transport already recognizes the same issue through `NO_BODY_RESPONSE_STATUSES` and returns `new Response(null, ...)`. A read-only Node probe confirmed that all three statuses throw `TypeError: Response constructor: Invalid response status code`.
- **Impact:** Any SDK or enterprise connection test using `createSafeOutboundFetchAdapter` fails on an otherwise valid 204/205/304 response. Common no-content operations such as revocation, deletion, health probes, or conditional requests become false network failures.
- **Fix:** Share the existing no-body status predicate with the adapter and pass `null` for 204, 205, and 304. Also return a null body for responses to `HEAD` requests.

### srv-security-guards-D1-001 — Stream normalization accumulates one abort listener per chunk

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/security/outboundHttp/safeOutboundFetchAdapter.ts:51-66,86-139`
- **Confidence:** HIGH
- **What:** Every `reader.read()` creates a new `abortPromise(signal)`, which installs a `{ once: true }` listener. When the read wins the race, that listener is never removed; only the separate `onAbort` listener is removed in `finally`.
- **Evidence:** Lines 115–117 repeatedly race `reader.read()` against `abortPromise(signal)`, while `abortPromise` at lines 52–66 exposes no cleanup mechanism. The `finally` block at lines 128–136 removes only `onAbort`. A completed N-chunk body therefore retains roughly N abort callbacks until the whole adapter invocation becomes collectible.
- **Impact:** A highly fragmented body under the 1 MiB byte limit can still create thousands of closures, trigger `MaxListenersExceededWarning`, and inflate request memory. This was introduced by the Round-4 bounded-body remediation.
- **Fix:** Use an abort race helper that removes its listener as soon as either branch settles, or attach one abort promise/listener for the entire read loop and clean it up once in `finally`.

### srv-security-guards-D2-001 — Round-4 adapter tests omit the cases that expose all three adapter regressions

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/enterprise/security/outboundHttp/safeOutboundFetchAdapter.test.ts:11-22,47-164`; `apps/server/src/enterprise/security/outboundHttp/safeOutboundHttpClient.client.test.ts:638-684`
- **Confidence:** HIGH
- **What:** Adapter tests hardcode a 200 response and cover only aborting/stalled bodies or a size overflow. They never complete a many-chunk stream, return 204/205/304, or verify headers after a POST-to-GET redirect.
- **Evidence:** `okClientResponse` always returns status 200 with body `"ok"`. The stream cases abort before or shortly after the first chunk. Redirect tests check rejection and credentials but never assert that entity/framing headers are removed after 301/302/303.
- **Impact:** The bodyless-response exception, abort-listener accumulation, and stale redirect headers all pass the current suite despite the adapter being a Round-4 security remediation target.
- **Fix:** Add regressions for:
  - successful completion of a highly fragmented stream with no residual abort listeners;
  - adapter responses with 204, 205, and 304;
  - same-origin POST redirects with explicit `Content-Length`, `Transfer-Encoding`, and `Content-Type`, asserting a valid bodyless GET hop.

### srv-security-guards-D5-002 — POST-to-GET redirects retain stale entity and framing headers

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/security/outboundHttp/safeOutboundHttpClient.ts:94-101,114-125,145-148,163-169,175-185,204-207,256-263`
- **Confidence:** HIGH
- **What:** For 301, 302, and 303, both request paths change the method to `GET` and clear the body, but retain the original header object unchanged.
- **Evidence:** `baseHeaders`/`headers` is created once and reused for every hop. The `forceGet` branches set only `method = 'GET'` and `body = undefined`. An explicit `Content-Length` or `Transfer-Encoding` from the original POST is therefore sent on the new GET with no matching body.
- **Impact:** Same-origin redirects can hang while the destination waits for the advertised body, fail with protocol errors, or send misleading entity metadata. This affects ordinary SDK requests because same-origin secret-bearing redirects are permitted.
- **Fix:** When forcing GET, remove `Content-Length`, `Transfer-Encoding`, and body-specific headers case-insensitively before the next hop. Centralize this with the method/body rewrite so buffered and streaming paths cannot drift.

### srv-security-guards-D5-003 — Documented startup secret gate is never invoked by production bootstrap

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/security/secret/platformSecretService.ts:184-203,206-239`; `apps/server/src/enterprise/security/secret/index.ts:47-51`; `apps/server/src/enterprise/security/secret/platformSecretService.test.ts:269-284`
- **Confidence:** HIGH
- **What:** `assertPlatformMasterKeyIfEnterprise` is documented as the startup configuration gate, but it has no production caller.
- **Evidence:** Repo-wide search finds the symbol only in its definition, barrel export, and unit tests. The comment says “Call from enterprise bootstrap,” but no bootstrap does so. Secret-dependent request paths perform their own lazy checks, while several workers/startup services still call nullable `tryFromEnv`.
- **Impact:** A deployment can accept traffic with enterprise features enabled and a missing or malformed key-provider configuration. The fault is discovered later, per request or job, causing avoidable runtime outages instead of a deterministic startup failure.
- **Fix:** Invoke the gate once from the real server bootstrap before accepting traffic and add a bootstrap-level regression test. If lazy initialization is the intended policy, remove the unused startup API and rewrite its contract rather than claiming fail-fast enforcement.

### srv-security-guards-D3-001 — Redirect credential-stripping branch is behaviorally dead and documentation is stale

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `apps/server/src/enterprise/security/outboundHttp/safeOutboundHttpClient.ts:246-254,456-496`; `apps/server/src/enterprise/security/outboundHttp/RESIDUAL.md:12-20`; `apps/server/src/enterprise/security/outboundHttp/index.ts:31-36`
- **Confidence:** HIGH
- **What:** `stripCredentialHeaders` cannot remove a non-empty header set during an actual cross-origin redirect.
- **Evidence:** `computeSecretBearing` returns true whenever any header exists or a body is present. The redirect branch throws before stripping when `secretBearing` is true. Therefore the stripping branch is reachable only with no caller headers and no body, making it a no-op. Nevertheless, the public barrel exports the helper and `RESIDUAL.md` states that custom credential headers are stripped.
- **Impact:** The production behavior and documented contract disagree, and maintainers may incorrectly rely on a sanitizing redirect path that never executes.
- **Fix:** Preserve the current fail-closed behavior, remove the dead stripping branch/export, and document that cross-origin redirects with caller headers or bodies are rejected. Only retain stripping if a deliberately narrower secret classifier is introduced and covered by tests.

### srv-security-guards-D3-002 — Test-only and internal helpers remain exported in production modules

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `apps/server/src/enterprise/guards/managedPlatformAgent.ts:55-67`; `apps/server/src/enterprise/guards/enterpriseErrors.ts:30-66`; `apps/server/src/enterprise/security/outboundHttp/policy.ts:259-265`; `apps/server/src/enterprise/security/outboundHttp/index.ts:7-26`
- **Confidence:** HIGH
- **What:** Several production exports have no production consumer.
- **Evidence:** Repo-wide searches show:
  - `assertAgentNotPlatformManaged` is referenced only by its own tests; production uses the batch form.
  - `mapEnterpriseCodeToTrpc` is called only inside `enterpriseErrors.ts`.
  - `isLoopbackIp` has no caller at all beyond its definition and barrel export.
- **Impact:** These exports enlarge an already broad security API, preserve obsolete single-item/test seams, and make future cleanup or behavior changes look compatibility-sensitive when they are not.
- **Fix:** Make the error mapper private, remove the unused loopback export/function, and test the production batch agent guard directly instead of retaining a test-only single-item wrapper.

## Dimensions with no findings

- **D4 Missing Simplified Chinese i18n:** Checked all scoped stable enterprise error codes against the admin locale catalog and `locales/zh-CN/admin.json`; the relevant keys exist and contain Chinese translations.
- **D6 Errors not surfaced via toast:** Scoped code is server-only. User-visible failures are returned through stable structured enterprise codes; swallowed exceptions are limited to secondary audit, metric, cleanup, or observability failures and do not make the primary action appear successful incorrectly.
- **D7 Technical/internal UI strings:** Internal diagnostics remain server-side, while transport-facing enterprise codes have plain-language localized client mappings. No scoped string was verified as being rendered raw to users.
- **D8 Missing animations/motion:** The assigned paths contain no UI components, visual state transitions, or loading surfaces to which upstream UI-library motion could apply.
