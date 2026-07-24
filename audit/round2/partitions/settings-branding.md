# Partition: settings-branding

## Summary

The partition has strong authorization, transactional publishing, owner-path preservation, secret filtering, and branding-scanner defenses, but contains two serious settings-resolution defects plus several bounded UI state and observability problems. CRITICAL: 0 · HIGH: 2 · MEDIUM: 4 · LOW: 4.

## Findings

### F1 \[HIGH]\[D5] Enabling settings policy discards existing registered user preferences

- **Location:** `apps/server/src/enterprise/services/settings/effectiveResolver.ts:145`, `apps/server/src/enterprise/services/settings/effectiveResolver.ts:215`, `apps/server/src/enterprise/services/settings/effectiveResolver.ts:221`, `apps/server/src/enterprise/services/settings/effectiveResolver.ts:226`, `apps/server/src/enterprise/services/settings/effectiveResolver.ts:251`, `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:249`, `packages/database/src/schemas/platform/settings.ts:94`
- **Evidence:** The resolver documents that registered paths “prefer override rows; legacy fills unregistered keys.” It initializes from legacy settings, but for every registered path constructs `userOverride` solely from `overrides[path]`, then overwrites the legacy leaf with the built-in/platform result via `setByPath(...)`. The service loads only `listUserOverrides(userId)`; no flag-on read path backfills registered legacy leaves. The schema states that override-row existence represents explicit user intent.
- **Impact / failure scenario:** A pre-existing user has `user_settings.general.fontSize = 18` and no `user_setting_overrides` row. After `ENABLE_PLATFORM_SETTINGS_POLICY` is enabled, resolution overwrites 18 with the built-in or platform default. This affects every registered preference and can silently change agent models, prompts, memory settings, UI preferences, and approval policy.
- **Fix:** Before admitting flag-on reads, run an idempotent transactional backfill that validates and copies registered legacy leaves into `user_setting_overrides`, bumps the per-user revision, and marks the user migrated. Add a regression test starting with only legacy registered values and then enabling the policy flag.
- **Confidence:** HIGH

### F2 \[HIGH]\[D5] Effective-settings cache reuses results materialized from different legacy inputs

- **Location:** `apps/server/src/enterprise/services/settings/effectiveResolver.ts:276`, `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:212`, `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:219`, `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:261`, `apps/server/src/enterprise/services/settings/runtimeSettingsAdapter.ts:140`, `apps/server/src/enterprise/services/settings/runtimeSettingsAdapter.ts:180`, `apps/server/src/enterprise/services/settings/runtimeSettingsAdapter.ts:204`, `apps/server/src/enterprise/services/settings/runtimeSettingsAdapter.ts:277`
- **Evidence:** `buildSettingsCacheKey` contains only registry revision, platform revision, user ID, and override revision. A cache hit returns the entire previous `EffectiveSettingsResult` before considering the current `legacyUserSettings`. Runtime adapters call the service for the same user with incompatible partial inputs such as `{ memory }`, `{ tool }`, or `{ defaultAgent, general, systemAgent, tool, memory }`.
- **Impact / failure scenario:** A tool-policy read can cache a result materialized only from `{ tool }`. A subsequent default-agent or system-agent read for the same user/revisions receives that cached object, losing unregistered legacy fields from its own slice. The result varies with request order and remains wrong until the five-second cache entry expires.
- **Fix:** Cache only the database-derived policy/override layer and merge the caller’s legacy input on every request. Alternatively, include a stable checksum of the sanitized legacy input in the key. ADD a cross-adapter regression test that invokes two different partial-slice readers in both orders.
- **Confidence:** HIGH

### F3 \[MEDIUM]\[D5] Branding publish leaves stale mutable state after conflicts or refresh failures

- **Location:** `src/enterprise/client/features/admin/branding/BrandingPage.tsx:269`, `src/enterprise/client/features/admin/branding/BrandingPage.tsx:272`, `src/enterprise/client/features/admin/branding/BrandingPage.tsx:276`, `src/enterprise/client/features/admin/branding/BrandingPage.tsx:278`, `src/enterprise/client/features/admin/branding/BrandingPage.tsx:418`
- **Evidence:** The publish result is discarded with `await adminBrandingService.publish(...)`. If the authoritative admin refresh fails after commit, the page only calls `setEditorState('idle')`; it retains the old revision/token and still shows `branding.status.published`. The mutation catch also unconditionally returns to `idle` instead of calling `markConflict()` for `PLATFORM_REVISION_CONFLICT`. The idle state re-enables Publish against the stale CAS values.
- **Impact / failure scenario:** A publication commits but `mutate()` fails. The page simultaneously reports success and a pending publication, then permits another publish that conflicts. Separately, a concurrent-admin conflict leaves the stale editor retryable indefinitely rather than directing the user to refresh.
- **Fix:** On a publish CAS error, enter the conflict state. After a committed publish, enter a dedicated “committed, refresh required” state that disables all mutations and offers refresh-only retry, following the settings-policy post-commit pattern. ADD tests for both branches.
- **Confidence:** HIGH

### F4 \[MEDIUM]\[D5] General Settings rehydration can overwrite unsaved edits

- **Location:** `src/enterprise/client/features/admin/generalSettings/GeneralSettingsPage.tsx:86`, `src/enterprise/client/features/admin/generalSettings/GeneralSettingsPage.tsx:95`, `src/enterprise/client/features/admin/generalSettings/useAdminAuthSettings.ts:8`
- **Evidence:** Every change to SWR `data` unconditionally executes `setDraft(...)`. The effect does not check whether the local draft is dirty or saving. Disabling `revalidateOnFocus` does not prevent data replacement through reconnect revalidation or shared-key mutation.
- **Impact / failure scenario:** An administrator edits registration or the email allowlist. Before saving, an SWR refresh returns a new server object; the effect replaces the local draft and silently erases the unsaved changes despite the navigation guard.
- **Fix:** Hydrate automatically only before editing. If server data changes while dirty, retain the local draft and enter a conflict/refresh state; update the baseline only after an explicit discard or successful save. ADD a rerender-with-new-data regression test.
- **Confidence:** HIGH

### F5 \[MEDIUM]\[D5] Persisted desktop and theme branding fields have no admin controls

- **Location:** `packages/database/src/schemas/platform/branding.ts:34`, `packages/database/src/schemas/platform/branding.ts:49`, `packages/database/src/schemas/platform/branding.ts:107`, `src/enterprise/client/features/admin/branding/BrandingPage.tsx:171`, `src/enterprise/client/features/admin/branding/BrandingPage.tsx:189`, `src/enterprise/client/features/admin/branding/BrandingPage.tsx:374`, `src/enterprise/client/features/admin/branding/BrandingFields.tsx:206`
- **Evidence:** The persisted draft includes `desktop.iconUrl`, `desktop.productName`, and `themeDefaults.primaryColor`. `BrandingPage` creates their translated labels and contains a `desktopIcon` upload branch, but `BrandingFields` renders only identity, runtime assets, links, and email fields. None of the desktop/theme labels or upload path is reachable.
- **Impact / failure scenario:** Administrators cannot configure three supported branding fields through the console. In particular, there is no UI path capable of invoking the otherwise implemented desktop-icon upload branch.
- **Fix:** Add Desktop and Theme sections binding all three fields, expose the desktop upload control, show the existing rebuild-required explanation, and add interaction tests.
- **Confidence:** HIGH

### F6 \[MEDIUM]\[D5] Publish failure audits use inconsistent action names and omit safe error categories

- **Location:** `apps/server/src/enterprise/services/branding/adminBrandingService.ts:294`, `apps/server/src/enterprise/services/branding/adminBrandingService.ts:502`, `apps/server/src/enterprise/services/branding/adminBrandingService.ts:547`, `apps/server/src/enterprise/services/branding/adminBrandingService.ts:695`, `apps/server/src/enterprise/routers/admin/branding.ts:178`, `apps/server/src/enterprise/services/settings/adminSettingsService.ts:683`, `apps/server/src/enterprise/services/settings/adminSettingsService.ts:741`
- **Evidence:** Branding’s durable operation lane is named `admin.branding.publish`, but publish failures and reauthentication denials are audited as `platform.branding.publish`. Branding and settings failure helpers both write `afterDiff: null`, even though branding already computes a redacted `operationErrorCategory(error)`.
- **Impact / failure scenario:** Publication-health aggregation keyed by canonical `admin.*.publish` actions omits branding failures. Included settings failures cannot be categorized as conflict, validation, or availability failures, reducing operational diagnosis to “unknown.”
- **Fix:** Normalize branding failure/denial audits to `admin.branding.publish`. Pass only a bounded, secret-safe error category in `afterDiff.error` for both settings and branding; never store raw exceptions or setting values. Update/add audit assertions.
- **Confidence:** HIGH

### F7 \[LOW]\[D2] FIX: cache TTL test deliberately locks in stale settings

- **Location:** `apps/server/src/enterprise/services/settings/effectiveSettingsService.test.ts:132`
- **Evidence:** The test comments, `Cache key omits legacyUserSettings, so hits keep serving the first materialization`, then changes the input to `zh-CN` while asserting the cached `en-US` value until expiry.
- **Impact / failure scenario:** A correct cache-key or per-call merge fix fails this test, making the suite actively preserve F2.
- **Fix:** FIX the test to require the new legacy input immediately. Test absolute TTL independently with identical caller input and observable database materialization counts.
- **Confidence:** HIGH

### F8 \[LOW]\[D2] FIX: branding save test treats a permanent CAS conflict as retryable

- **Location:** `src/enterprise/client/features/admin/branding/BrandingPage.test.tsx:219`
- **Evidence:** The mock first rejects with `PLATFORM_REVISION_CONFLICT`, then the test invokes `modal.onSubmit(payload)` again with the exact same stale `expectedDraftToken` and expects success.
- **Impact / failure scenario:** A real CAS token cannot become valid again. The test validates an impossible backend sequence and fails to assert the required conflict/refresh behavior.
- **Fix:** FIX this test by using a transient non-CAS error for same-payload retry. Add a separate conflict case that asserts conflict state, disabled mutations, and authoritative refresh.
- **Confidence:** HIGH

### F9 \[LOW]\[D1] Accepted asset upload can strand its reservation when cleanup fails

- **Location:** `apps/server/src/enterprise/services/branding/adminBrandingAssetService.ts:352`, `apps/server/src/enterprise/services/branding/adminBrandingAssetService.ts:370`, `apps/server/src/enterprise/services/branding/adminBrandingAssetService.ts:372`
- **Evidence:** The service first commits an `uploading` reservation, then calls `await this.sweep(...)` outside the `try` whose catch invokes `compensate(reservation)`.
- **Impact / failure scenario:** If cleanup candidate discovery throws after reservation, no upload occurs and no compensation runs. The request leaves an uploading row and blocks its idempotency lane until the five-minute lease expires.
- **Fix:** Put the sweep inside the compensated `try`, or catch sweep failure separately and atomically release/orphan the accepted reservation before rethrowing. ADD a sweep-rejection test.
- **Confidence:** HIGH

### F10 \[LOW]\[D1] Branding literal policy remains an over-coupled 915-line module

- **Location:** `scripts/enterprise/brandingLiterals.ts:228`, `scripts/enterprise/brandingLiterals.ts:250`, `scripts/enterprise/brandingLiterals.ts:657`, `scripts/enterprise/brandingLiterals.ts:719`, `scripts/enterprise/brandingLiterals.ts:780`, `scripts/enterprise/brandingLiterals.ts:839`
- **Evidence:** One file owns obfuscation decoding, repository-path security, TypeScript static evaluation, semantic classification, file scanning, and baseline validation/building.
- **Impact / failure scenario:** Changes to one parser or policy concern require reviewing a large shared module and increase the chance of unrelated classification regressions.
- **Fix:** Split path/decoding policy, script-fragment evaluation, occurrence classification, and baseline validation into focused modules while retaining the existing public facade and tests.
- **Confidence:** HIGH

## Dimension coverage

① Code smells — Found the uncompensated pre-upload cleanup boundary (F9) and the over-coupled scanner module (F10); no unbounded settings/branding queries or material N+1 paths were confirmed.

② Test rot — FIX the two stale tests in F7 and F8; environment-gated PostgreSQL concurrency suites are legitimate, and ADD actions for missing regressions are included in F1–F6.

③ Dead code & dev cruft — The desktop-icon upload branch and desktop/theme labels are currently unreachable because their controls are absent (F5); no other material debug, backup, generated, or deprecated cruft was confirmed.

④ Missing Simplified-Chinese i18n — Clean: admin en-US and zh-CN have exact key parity, literal `t(...)` references resolve, equal values are technical names/placeholders, and no in-scope production UI hardcodes requiring translation were found.

⑤ Functional bugs — Issues cluster in legacy effective-value migration/cache semantics (F1–F2), editor conflict/post-commit handling (F3–F4), incomplete branding controls (F5), and publication audit observability (F6). Owner-filtered empty settings publishes, whole-draft CAS writes, publish-only reauthentication, settings-value redaction, and controlled branding assets were otherwise clean.
