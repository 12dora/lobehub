# Partition: contracts

## Summary

The contract layer generally uses strict Zod objects and closed-by-default feature flags, but several high-risk boundaries remain: credential metadata exposure, fail-open registration policy, lost-update concurrency, and unrecoverable secret-rotation states. CRITICAL: 0 · HIGH: 4 · MEDIUM: 2 · LOW: 2.

## Findings

### F1 \[HIGH]\[D5] Read-only AI DTOs expose a deterministic credential verifier

- **Location:** `apps/server/src/enterprise/contracts/aiCatalog.ts:188`; `apps/server/src/enterprise/contracts/aiCatalog.ts:217`; `apps/server/src/enterprise/contracts/aiCatalog.ts:290`; `apps/server/src/enterprise/contracts/aiCatalog.ts:319`; `apps/server/src/enterprise/contracts/aiCatalog.test.ts:81`; `packages/const/src/platform/roles.ts:82`
- **Evidence:** `aiSecretStateSchema` exposes `fingerprint: z.string().min(1).nullable()`, and both provider list and detail outputs embed that state. The test fixture explicitly accepts `secret: { configured: true, fingerprint: 'fp', ... }`. The default auditor receives every permission containing `:read:`, including `AI_PROVIDER_READ`. The verified server mapper populates this field with the first 16 hexadecimal characters of SHA-256 over the serialized credential object.
- **Impact / failure scenario:** An auditor or other read-only AI-catalog principal can obtain a stable, 64-bit verifier for credentials. For low-entropy structured credentials such as known usernames plus guessed basic-auth passwords or custom header values, guesses can be tested offline; fingerprints also reveal credential reuse across revisions or providers.
- **Fix:** Remove `fingerprint` from the client-facing `aiSecretStateSchema`; expose only `configured` and `updatedAt`, keeping fingerprints server-internal. **FIX** the existing output-safety test so it rejects a fingerprint field rather than treating it as safe.
- **Confidence:** HIGH

### F2 \[HIGH]\[D5] Enabled email-domain allowlisting fails open when the list is empty

- **Location:** `packages/types/src/platform/authSettings.ts:10`; `packages/types/src/platform/authSettings.ts:37`; `packages/types/src/platform/authSettings.ts:77`; `packages/types/src/platform/authSettings.test.ts:29`
- **Evidence:** `platformAuthSettingsSchema` independently accepts `emailDomainAllowlist: []` and `emailDomainAllowlistEnabled: true`. The matcher then states and implements: `if (allowlist.length === 0) return true`. The actual registration guard invokes this matcher when the enabled flag is true.
- **Impact / failure scenario:** An administrator enables domain restriction but saves an empty domain field. The contract accepts the state, after which every email address passes self-registration despite the UI indicating that allowlisting is enabled.
- **Fix:** Add a schema-level refinement requiring at least one domain whenever `emailDomainAllowlistEnabled` is true. Keep the empty-list helper behavior only for callers where allowlisting is disabled. **ADD** regression tests for enabled-plus-empty rejection and disabled-plus-empty acceptance.
- **Confidence:** HIGH

### F3 \[HIGH]\[D5] Full-document settings updates allow stale administrators to overwrite security changes

- **Location:** `apps/server/src/enterprise/contracts/adminAuthSettings.ts:5`; `apps/server/src/enterprise/contracts/adminSidebarLayout.ts:5`
- **Evidence:** Both contracts explicitly declare “direct-save; no draft/publish CAS.” Their update inputs are the complete settings objects, with no revision or `expectedRevision`, and their outputs carry no new revision.
- **Impact / failure scenario:** Administrators A and B load the same authentication settings. A disables open registration and saves. B later changes the domain list using the stale document, which still contains `openRegistration: true`; B’s full-document update succeeds and silently reopens registration. Sidebar updates suffer the same last-writer-wins data loss.
- **Fix:** Return a revision with each document, require `{ expectedRevision, settings }` or `{ expectedRevision, layout }` for updates, and make the server update conditional on that revision. **ADD** concurrent-update tests asserting that the stale writer receives a conflict.
- **Confidence:** HIGH

### F4 \[HIGH]\[D5] Cancelled and dead secret-rotation jobs cannot be restarted

- **Location:** `apps/server/src/enterprise/contracts/adminSecretRotation.ts:13`; `apps/server/src/enterprise/contracts/adminSecretRotation.ts:48`; `apps/server/src/enterprise/contracts/adminSecretRotation.ts:62`
- **Evidence:** Job output recognizes terminal statuses `cancelled`, `dead`, and `failed`, but retry requires `expectedStatus: z.literal('failed')`. Start accepts only `targetKeyId` and has no restart generation or nonce. The verified coordinator deduplicates starts by target key and returns the existing terminal job, while its retry path additionally requires a failure ledger that cancelled jobs do not have.
- **Impact / failure scenario:** An administrator cancels a running rotation and later starts rotation toward the same active key. Start returns the old cancelled job; retry cannot pass the schema. A worker-marked `dead` job is similarly stranded. Old-key ciphertext remains indefinitely and can prevent retirement of the historical key.
- **Fix:** Add an explicit restart contract for `cancelled` and recoverable `dead` jobs, carrying the terminal revision and a new generation/idempotency identifier. Keep failed-ledger retry semantics separate. **ADD** cancel→restart and dead→restart regression tests.
- **Confidence:** HIGH

### F5 \[MEDIUM]\[D5] Audit job DTOs expose raw internal exception messages

- **Location:** `apps/server/src/enterprise/contracts/adminAudit/exports.ts:116`; `apps/server/src/enterprise/contracts/adminAudit/retention.ts:56`
- **Evidence:** Both public schemas permit arbitrary `error.code` and `error.message` strings: `code: z.string().optional(), message: z.string().optional()`. The verified workers persist raw `Error.name` and up to 500 characters of `Error.message`, and the export projection returns the stored error unchanged.
- **Impact / failure scenario:** A storage or database operation throws an error containing an object key, table detail, endpoint, or other internal identifier. The worker persists that text and an audit reader receives it through a DTO whose own comment promises that `storageKey` is never exposed.
- **Fix:** Replace free-form public errors with a bounded enum of stable error codes or message keys and omit raw messages. Sanitize exceptions before persistence/projection. **ADD** tests injecting an exception containing a storage key or secret marker and asserting that neither reaches the DTO.
- **Confidence:** HIGH

### F6 \[MEDIUM]\[D5] “JSON object” schemas accept values that change during JSONB persistence

- **Location:** `apps/server/src/enterprise/contracts/aiCatalog.ts:32`; `apps/server/src/enterprise/contracts/aiCatalog.ts:81`; `apps/server/src/enterprise/contracts/aiCatalog.ts:127`; `apps/server/src/enterprise/contracts/aiCatalog.test.ts:174`
- **Evidence:** The base schema is `z.record(z.string(), z.unknown())`. During traversal, every non-object value other than strings reaches `continue` without a type check, while arbitrary objects are handled through `Object.entries`. Consequently nested `undefined`, `NaN`, `Infinity`, `Date`, and other non-JSON values pass despite the schema’s JSON claim.
- **Impact / failure scenario:** A SuperJSON client submits `{ temperature: undefined, threshold: NaN, seenAt: Date }`. Validation succeeds, but JSONB serialization omits `temperature`, converts the non-finite number to `null`, and converts the date to a string. The stored draft and its derived token/revision no longer represent the accepted input.
- **Fix:** Recursively accept only `null`, strings, booleans, finite numbers, arrays, and plain string-keyed objects. Reject undefined, non-finite numbers, and non-plain objects before size and secret checks. **ADD** persistence-shape regression tests for these values.
- **Confidence:** HIGH

### F7 \[LOW]\[D1] Credential header maps lack complete cardinality and size bounds

- **Location:** `apps/server/src/enterprise/contracts/aiCatalog.ts:146`; `apps/server/src/enterprise/contracts/platformConnectors/common.ts:180`
- **Evidence:** AI credentials define `customHeaders: z.record(z.string(), z.string()).optional()` with no key length, value length, or entry-count limit. Connector credentials bound individual header keys and values but still impose no maximum entry count.
- **Impact / failure scenario:** A privileged request can submit thousands of headers, or unusually large AI header names and values, forcing unnecessary validation, serialization, encryption, and database work and potentially creating credentials that downstream HTTP clients cannot use. The only effective ceiling is an unrelated transport-body limit.
- **Fix:** Apply a shared header-map schema with a conservative entry limit, bounded non-empty names and values, and rejection of control characters. **ADD** count and length boundary tests.
- **Confidence:** HIGH

### F8 \[LOW]\[D3] Secret-contract internals are exported despite having no external callers

- **Location:** `apps/server/src/enterprise/contracts/platformConnectors/secrets.ts:43`; `apps/server/src/enterprise/contracts/platformConnectors/secrets.ts:52`; `apps/server/src/enterprise/contracts/platformConnectors/secrets.ts:64`; `apps/server/src/enterprise/contracts/platformConnectors/secrets.ts:65`; `apps/server/src/enterprise/contracts/platformConnectors/secrets.ts:68`; `apps/server/src/enterprise/contracts/platformConnectors/secrets.ts:99`; `apps/server/src/enterprise/contracts/platformConnectors/secrets.ts:233`
- **Evidence:** `trustedSecretContexts`, the two secret-key sets, `normalizeSecretStructureKey`, `collectSecretLeafValues`, `collectSecretSlots`, and `isConfiguredSlotConsistent` are exported. Whole-repository usage checks, excluding the prohibited audit directory, found each symbol only in this implementation file.
- **Impact / failure scenario:** Sensitive trust-state and secret-structure implementation details become an unnecessary callable surface, encouraging external coupling and making future hardening more difficult.
- **Fix:** Remove `export` from helpers still used locally and delete any helper that becomes unused. Retain only the deliberate public normalizers, assertions, types, and trusted-context loader.
- **Confidence:** HIGH

## Dimension coverage

① Checked schema complexity, bounds, duplicated shapes, concurrency tokens, and unbounded collections; F6 and F7 contain the main schema-quality issues.

② Checked in-scope tests for `skip`, `todo`, `only`, network/random/time coupling, and stale assertions; none are skipped or focused, but F1 requires **FIX**, while F2–F7 identify specific **ADD** regression coverage.

③ Checked exports, usages, TODO/FIXME markers, debug statements, and committed cruft; F8 is the confirmed dead public surface, with no other reportable cruft found.

④ Checked user-facing labels/messages in platform types and constants for hardcoded untranslated English, missing zh-CN keys, and wrong namespaces; this partition is clean.

⑤ Traced registration, AI credential projection, settings mutations, secret rotation, audit error projection, identity-provider previews, and connector DTOs end to end; confirmed defects cluster in F1–F6, while identity-provider claim summaries are intentionally privacy-mapped and consistent.
