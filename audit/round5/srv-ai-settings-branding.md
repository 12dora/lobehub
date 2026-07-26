# Round 5 Audit — srv-ai-settings-branding

## Scope

Audited all fork-owned files under:

- `apps/server/src/enterprise/services/aiCatalog`
- `apps/server/src/enterprise/services/settings`
- `apps/server/src/enterprise/services/branding`

The baseline comparison found 73 added files containing 21,771 lines of fork delta. Because every file differed from baseline, none were excluded as byte-identical upstream code. Production callers and database implementations outside these paths were inspected only where necessary to verify scoped behavior.

This was a static, read-only audit; no tests, formatters, or write-capable commands were run.

## Summary

| Dimension                                             | Findings | Highest severity |
| ----------------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                        |        4 | HIGH             |
| D2 Test decay                                         |        2 | MEDIUM           |
| D3 Dead code and development debris                   |        0 | —                |
| D4 Missing Simplified Chinese i18n coverage           |        0 | —                |
| D5 Potential functional bugs                          |        3 | MEDIUM           |
| D6 Warnings and errors not surfaced via toast         |        0 | —                |
| D7 Overly technical/internal-state-leaking UI strings |        0 | —                |
| D8 Missing animations/motion                          |        0 | —                |

## Findings

### srv-ai-settings-branding-D1-01 — Model removal validation performs a two-query N+1 loop

- **Severity:** HIGH
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/services/aiCatalog/publication.ts:84-109`; `apps/server/src/enterprise/services/aiCatalog/dependencies.ts:34-39`; `apps/server/src/enterprise/services/aiCatalog/dependencies.ts:45-90`
- **Confidence:** HIGH
- **What:** Publication validates each removed model separately even though the dependency module already exposes a batch resolver.
- **Evidence:** `assertRemovedModelsUnused` runs `Promise.all(removed.map(... resolveAiCatalogDependents(...)))`. The single-model resolver delegates to `resolveAiCatalogDependentsForModels` with a one-element array. Each invocation performs one agent-reference query and one published-settings query, followed by another scan of the published settings. The same batch resolver is already used by other AI catalog service paths.
- **Impact:** Removing or rolling back (N) models creates approximately (2N) database queries and repeatedly scans the same settings data. With large catalogs, this can flood the connection pool while publication locks are held, making an ordinary bulk archive or rollback slow or unreliable.
- **Fix:** Group removed references by provider and invoke `resolveAiCatalogDependentsForModels` once per provider with the complete model-key array. Deduplicate the returned dependents once after the batched calls.

### srv-ai-settings-branding-D1-02 — “Bounded” branding orphan cleanup has no independent runner

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/services/branding/adminBrandingAssetService.ts:110-116`; `apps/server/src/enterprise/services/branding/adminBrandingAssetService.ts:287-335`; `apps/server/src/enterprise/services/branding/adminBrandingAssetService.ts:364-368`; `apps/server/src/enterprise/services/branding/adminBrandingAssetService.ts:501-639`
- **Confidence:** HIGH
- **What:** Failed or expired branding assets are marked for a bounded sweep, but production code invokes that sweep only after another upload.
- **Evidence:** Upload results advertise `orphanPolicy: 'bounded_sweep'`, and failed compensation records `orphaned` plus `cleanupAfter`. The only production call to `sweep` is at the end of the upload path. A repository-wide caller search found no scheduled job, worker, or startup task that invokes this sweep independently.
- **Impact:** If the final upload fails, or an unpinned asset expires after upload activity stops, its object and database record remain indefinitely. Storage usage therefore grows without the bound promised by the policy.
- **Fix:** Register `sweep` with the repository’s existing background workflow or scheduled-job mechanism. Retain bounded batch sizes, leases, and retry delays; the opportunistic post-upload sweep can remain as an acceleration path, but must not be the sole trigger.

### srv-ai-settings-branding-D1-03 — Public branding snapshot serializes independent database reads

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/services/branding/resolvePublicSnapshot.ts:54-91`
- **Confidence:** HIGH
- **What:** Branding, authentication settings, and identity-target reads are awaited sequentially even though they are independent after the database handle is obtained.
- **Evidence:** The code first awaits branding resolution, then awaits authentication settings, then conditionally awaits identity target resolution. Its own comment states that branding and authentication are independent; the identity query also consumes no result from either prior query.
- **Impact:** Metadata, manifest, SPA-auth, and runtime-agent consumers pay the sum of all query latencies. Round 4 added the identity lookup as another serialized stage, increasing request-path latency.
- **Fix:** Start the applicable reads together and await them with `Promise.all`, retaining the existing per-source safe fallbacks so one optional branding or identity failure does not change the snapshot’s failure semantics.

### srv-ai-settings-branding-D1-04 — Effective-settings service has accumulated several unrelated responsibilities

- **Severity:** LOW
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:64-889`
- **Confidence:** HIGH
- **What:** The 889-line service exceeds the repository’s approximately 800-line split guideline and combines cache implementations, snapshot materialization, legacy-data migration, override mutation, reset behavior, and test hooks.
- **Evidence:** Cache state and eviction occupy roughly lines 64-179, resolution and legacy backfill lines 195-588, mutation/reset behavior lines 590-873, and test-only helpers lines 882-889. The legacy migration and mutation logic also have separate transaction requirements, making the combined class harder to reason about.
- **Impact:** Cross-cutting changes can unintentionally alter cache, migration, and mutation behavior together. The incomplete transaction boundary identified below is an example of the resulting maintenance risk.
- **Fix:** Extract the cache implementation, effective-snapshot materializer/legacy migrator, and mutation facade into focused modules while keeping the public service API stable.

### srv-ai-settings-branding-D2-01 — Disabled-runtime test contradicts the production implementation

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/enterprise/services/branding/runtimeBranding.test.ts:8-16`; `apps/server/src/enterprise/services/branding/runtimeBranding.ts:29-36`; `apps/server/src/enterprise/services/branding/resolvePublicSnapshot.ts:43-46`
- **Confidence:** HIGH
- **What:** The test asserts that disabling Runtime Branding prevents database access, but the current implementation always requests a database handle.
- **Evidence:** The test passes a `vi.fn()` database factory and expects it not to have been called. `resolveServerRuntimeBrandingSnapshot` unconditionally delegates to `resolvePlatformPublicSnapshot`, whose first operation is `await getDatabase()`, before checking the branding flag.
- **Impact:** The test cannot pass against the checked-in implementation. It also masks the production flag regression described in D5-01, weakening confidence in the intended rollback behavior.
- **Fix:** Restore the flag-off early return before snapshot/database resolution and retain this test as a regression guard. Add coverage for both snapshot and plain runtime-branding entry points.

### srv-ai-settings-branding-D2-02 — Legacy-backfill tests omit the durable cleanup and rollback invariant

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/enterprise/services/settings/effectiveSettingsService.test.ts:196-221`; `apps/server/src/enterprise/services/settings/transactionFaults.test.ts:72-425`
- **Confidence:** HIGH
- **What:** Tests verify that a legacy value becomes an override and remains readable, but do not verify that the legacy leaf was durably removed or that an intervening cleanup failure rolls back the inserted override.
- **Evidence:** The backfill test performs two effective reads and checks the resolved value. It never reloads the legacy settings row. The transaction-fault suite covers update and reset paths, but a repository-wide search found no injected failure between `insertUserOverridesIfAbsent` and `stripRegisteredLegacyLeaves`.
- **Impact:** The split-transaction partial commit in D5-02 can ship undetected: a read reports failure after changing durable state, and subsequent reads pass because the override now exists.
- **Fix:** Add a fault-injection test that fails legacy stripping after override insertion and asserts that the override, revision, and legacy row all remain unchanged. Add a success assertion that directly verifies removal of the migrated legacy leaf.

### srv-ai-settings-branding-D5-01 — Disabling Runtime Branding does not disable its database work

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/branding/runtimeBranding.ts:29-36`; `apps/server/src/enterprise/services/branding/runtimeBranding.ts:48-52`; `apps/server/src/enterprise/services/branding/resolvePublicSnapshot.ts:43-46`; `apps/server/src/enterprise/services/branding/resolvePublicSnapshot.ts:57-91`
- **Confidence:** HIGH
- **What:** Both runtime-branding entry points resolve the complete platform snapshot even when `runtimeBrandingEnabled` is false.
- **Evidence:** The flag is forwarded into `resolvePlatformPublicSnapshot`, but that function obtains the database first. Only the branding read is gated; authentication settings are always queried, and the DB-OIDC identity target may also be queried. This directly violates the scoped test’s stated “does not touch the database” contract.
- **Impact:** Turning the enterprise feature off does not restore the intended no-I/O upstream behavior. Metadata, manifest, SPA SEO, and agent-runtime callers remain dependent on the enterprise database and pay its latency; a database outage can affect these paths even though Runtime Branding is disabled.
- **Fix:** Return an empty runtime-branding result before calling `resolvePlatformPublicSnapshot` when the flag is false. If authentication/identity snapshots are independently required, expose them through a separately named resolver so the branding feature flag retains a clear rollback boundary.

### srv-ai-settings-branding-D5-02 — Legacy settings backfill commits before legacy cleanup

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:510-545`; `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:547-574`
- **Confidence:** HIGH
- **What:** Backfill inserts new overrides and then removes legacy leaves in a separate database operation rather than one atomic transaction.
- **Evidence:** `backfillRegisteredLegacyOverrides` first awaits `insertUserOverridesIfAbsent`. It then constructs the new override state and calls `stripRegisteredLegacyLeaves`, which loads and updates the user settings through the service’s normal database handle. The underlying insert helper commits its own transaction before returning. If stripping fails, the insert and revision change remain committed.
- **Impact:** An effective-settings read can return an error after mutating durable state. On retry, the existing override causes backfill to skip that path, so cleanup is not retried and a stale legacy copy remains. This creates a half-migrated representation that can later become authoritative if the override is removed by a path that does not also strip the legacy leaf.
- **Fix:** Perform the conditional override insertion, revision update, and legacy-leaf removal in one database transaction. Ensure the model helpers share that transaction rather than opening and committing independent transactions.

### srv-ai-settings-branding-D5-03 — A published provider cannot be disabled when its stored secret is unreadable

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/aiCatalog/publication.ts:157-170`; `apps/server/src/enterprise/services/aiCatalog/publication.ts:213-230`
- **Confidence:** HIGH
- **What:** The publication validator explicitly relaxes runtime-readiness requirements when disabling an already published provider, but still unconditionally decrypts and normalizes its credential vault.
- **Evidence:** `isDeactivatingPublished` bypasses enabled-model and connection-test readiness checks. Later, regardless of that condition, the code loads the provider, decrypts `encryptedKeyVaults`, checks credential leakage, and calls `normalizeAiCatalogExecutionCredentials`. An unreadable ciphertext becomes a publish validation issue.
- **Impact:** After key loss, rotation mistakes, or credential corruption, an administrator cannot publish `enabled: false` through the normal toggle flow. A provider with unusable credentials may remain advertised as active until the administrator discovers and uses the separate archive operation.
- **Fix:** Treat deactivation as a true emergency-safe path. Build its published revision from the last known public payload with only `enabled: false`, preserving opaque secret metadata without decrypting it. Continue applying public-field leakage checks to any newly accepted public fields, but do not require runtime credentials to be readable merely to turn a provider off.

## Dimensions with no findings

- **D3 Dead code and development debris:** Repo-wide caller searches were performed for scoped exports, compatibility helpers, sweep entry points, test helpers, TODO/FIXME markers, skips, and console logging. The remaining test-only exports and fallback logs have verified callers or explicit purposes.
- **D4 Missing Simplified Chinese i18n coverage:** Registry title, description, option-label, and generated system-agent keys were checked against the default, en-US, and zh-CN catalogs. No missing, empty, or improperly English zh-CN value was verified in scope.
- **D6 Warnings and errors not surfaced via toast:** Scoped mutation failures are rethrown or converted to stable caller-facing errors. Post-commit cache-invalidation failures are intentionally logged as degraded consistency rather than misreporting an already committed operation as failed.
- **D7 Overly technical/internal-state-leaking UI strings:** Internal validation details remain structured server diagnostics; inspected consumers map them to localized, user-facing summaries instead of rendering raw codes, database details, or exception messages.
- **D8 Missing animations/motion:** These paths contain server services and DTO logic only. They define no user-visible panels, lists, dialogs, loading surfaces, or state transitions where an upstream UI-library animation can be applied.
