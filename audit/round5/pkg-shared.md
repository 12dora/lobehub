# Round 5 Audit — pkg-shared

## Scope

Audited the fork delta against `4bab1636408e60a7ee17b640490fbf33a310a325` across the 11 assigned package trees.

The delta contains **260 files, 45,775 additions, 352 deletions, net +45,423 LOC**:

- `packages/database/src`: 146 files, net +36,466
- `packages/types/src`: 29 files, net +1,942
- `packages/const/src`: 16 files, net +875
- `packages/trpc/src`: 10 files, net +802
- `packages/env/src`: 4 files, net +65
- `packages/openapi/src`: 7 files, net +109
- `packages/locales/src`: 13 files, net +3,161
- `packages/model-runtime/src`: 21 files, net +976
- `packages/model-bank/src`: 5 files, net +83
- `packages/device-control/src`: 6 files, net +712
- `packages/utils/src`: 3 files, net +232

Upstream-identical files were excluded. Callers and generated `locales/zh-CN` resources outside these paths were inspected only to verify fork seams, i18n fallbacks, and user-visible behavior. This was a static, read-only audit; no write-capable checks were run.

## Summary

| Dimension                                     | Findings | Highest severity |
| --------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                |        3 | HIGH             |
| D2 Test decay                                 |        2 | HIGH             |
| D3 Dead code and development debris           |        1 | LOW              |
| D4 Missing Simplified Chinese i18n coverage   |        1 | LOW              |
| D5 Potential functional bugs                  |        3 | CRITICAL         |
| D6 Warnings and errors not surfaced via toast |        0 | —                |
| D7 Overly technical UI strings                |        1 | LOW              |
| D8 Missing animations / motion                |        0 | —                |

## Findings

### pkg-shared-D5-001 — Default-off enterprise flag disables the pre-existing OIDC banned-user check

- **Severity:** CRITICAL
- **Dimension:** D5 Potential functional bugs
- **Location:** `packages/trpc/src/lambda/context.ts:27-30`, `packages/trpc/src/lambda/context.ts:273-311`, `packages/const/src/platform/featureFlags.ts:37-47`
- **Confidence:** HIGH
- **What:** The fork placed OIDC user existence, ban, and credential-invalidation checks behind `ENABLE_PLATFORM_ADMIN`/`ENABLE_ENTERPRISE_ADMIN`. Both flags default to off. This removes an unconditional upstream security check in ordinary/default deployments.
- **Evidence:** `isPlatformAdminSecurityOn()` is true only when either admin flag is explicitly enabled. After `validateOIDCJWT`, lines 293-296 call `assertUserActive` only inside `if (securityOn)`, then accept the JWT and return an authenticated context. The baseline called `assertOIDCUserActive(db, userId)` unconditionally after JWT validation, with an explicit comment that banned or deleted accounts must not continue using an issued token. The replacement helper rejects missing users, effective bans, and invalidated credentials, so skipping it is security-relevant rather than an optimization. `DEFAULT_ENTERPRISE_FEATURE_FLAGS` sets both controlling capabilities off.
- **Impact:** A banned or deleted user with an unexpired OIDC access token remains authenticated to normal TRPC endpoints whenever platform administration is not enabled. The same applies to tokens issued before an invalidation cutoff. This defeats account revocation until token expiry.
- **Fix:** Preserve the baseline invariant independently of enterprise feature flags. Always check that an OIDC subject exists and is not effectively banned. If `authInvalidatedAt` must remain enterprise-gated, split the helper into an unconditional baseline activity check and a separately gated epoch check instead of gating the entire `assertUserActive` call.

### pkg-shared-D1-001 — Chart cardinality caps are applied only after the unbounded SQL result is materialized

- **Severity:** HIGH
- **Dimension:** D1 Code smells
- **Location:** `packages/database/src/models/platform/globalStats.ts:80-89`, `packages/database/src/models/platform/globalStats.ts:130-230`, `packages/database/src/models/platform/globalStats.ts:849-923`
- **Confidence:** HIGH
- **What:** `findAndGroupByDay` claims bounded chart cardinality, but PostgreSQL still returns every distinct day × user × model × provider combination. The top-20-user, top-30-model, and top-20-provider limits are applied only afterward in application memory.
- **Evidence:** Lines 893-909 execute an unrestricted grouped query with no `LIMIT`, rank, or SQL-side “other” bucket. The complete `dimRows` array is then reorganized at lines 912-923 and passed to `capGroupByDayRecords`. The cap therefore bounds only the final response, not database work, network transfer, or Node.js memory. This is the normal implementation behind the admin `usageFindAndGroupByDay` query.
- **Impact:** A large enterprise installation with many users and model/provider combinations can produce hundreds of thousands or millions of grouped rows for one request, causing slow queries, high memory use, event-loop pressure, or process termination. This defeats the Round-4 remediation’s stated OOM protection.
- **Fix:** Aggregate and rank inside SQL. Use CTEs/window functions to identify per-day top users/models/providers, map long-tail dimensions to synthetic “other” values with `CASE`, and group again before returning rows to Node. Add a high-cardinality regression test that asserts the database result itself is bounded.

### pkg-shared-D2-001 — Authentication tests omit the flag-off OIDC invariant that regressed

- **Severity:** HIGH
- **Dimension:** D2 Test decay
- **Location:** `packages/trpc/src/lambda/context.test.ts:168-190`, `packages/trpc/src/lambda/context.test.ts:262-286`, `packages/trpc/src/lambda/context.test.ts:337-388`
- **Confidence:** HIGH
- **What:** Every OIDC activity-check test runs with platform administration enabled. The only flag-off test covers API-key authentication and explicitly expects the user activity check to be skipped.
- **Evidence:** `beforeEach` sets `ENABLE_PLATFORM_ADMIN=1`. The test at lines 262-286 changes it to `0`, but exercises only an API key. OIDC active/inactive tests at lines 337-388 inherit the enabled flag. A repository-wide search found no test for an inactive OIDC subject with the flag unset or disabled.
- **Impact:** The suite passes while default deployments accept banned/deleted OIDC users. This is missing critical regression coverage for a security guarantee that existed in the baseline.
- **Fix:** Add cases for unset, `0`, and false-like admin flags where an otherwise valid OIDC JWT belongs to a missing, banned, temporarily banned, or invalidated user. Each must return an unauthenticated context without falling back to session authentication.

### pkg-shared-D1-002 — Failed TTL deletion has no retry and leaves permanent in-memory state

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `packages/device-control/src/inlineSkillWorkspace.ts:147-177`, `packages/device-control/src/__tests__/inlineSkillWorkspace.test.ts:150-177`
- **Confidence:** HIGH
- **What:** An inline-skill workspace receives exactly one TTL callback. If recursive deletion fails, the callback swallows the rejection and never schedules another attempt, while `activeWorkspaces` retains the entry.
- **Evidence:** Lines 147-153 catch cleanup failure with an empty handler. `cleanupInlineSkillWorkspace` deliberately removes the map entry only after successful deletion. Its comment says a failure remains retryable through a “later TTL”, but no later timer is created. The regression test verifies only that the rejection is swallowed and that `removePath` was called; it does not expect a retry.
- **Impact:** A transient `EPERM`, `EBUSY`, antivirus lock, or filesystem failure can leave skill source/resources and their map entry resident until manual cleanup or process restart. On an idle long-lived device process, the directory can remain indefinitely.
- **Fix:** Reschedule failed TTL cleanup with bounded exponential backoff and a maximum retry count, retaining only redacted structured diagnostics. Add a test that fails the first deletion, advances the scheduled retry, and verifies both directory and registry entry are eventually removed.

### pkg-shared-D5-002 — UTC range bounds are combined with session-local SQL day buckets

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `packages/database/src/models/platform/globalStats.ts:24-60`, `packages/database/src/models/platform/globalStats.ts:386-428`, `packages/database/src/models/platform/globalStats.ts:849-871`, `packages/database/src/models/platform/globalStats.ts:925-972`, `packages/database/src/models/__tests__/platform.globalStats.test.ts:241-300`, `packages/database/src/models/__tests__/platform.globalStats.test.ts:490-517`
- **Confidence:** HIGH
- **What:** The Round-4 code filters month boundaries in UTC but groups timestamps with PostgreSQL’s current session timezone and constructs/pads dates with the Node process timezone.
- **Evidence:** Both chart queries use `to_char(date_trunc('day', messages.createdAt), 'YYYY-MM-DD')`. For a `timestamptz`, PostgreSQL evaluates this in the session timezone unless explicitly converted. Meanwhile `genHalfOpenDayRangeWhere` uses UTC midnights. The padding and default month use raw `dayjs(...).startOf(...)`. Tests use UTC-shaped timestamps but never change the database or process timezone.
- **Impact:** With a non-UTC database/session timezone, events near UTC midnight are assigned to the previous or following label. At month boundaries, a row can pass the UTC filter but be grouped under a date absent from the padded month, producing missing or shifted totals.
- **Fix:** Use an explicit UTC expression such as `date_trunc('day', created_at AT TIME ZONE 'UTC')` for both selection and grouping, and perform padding/default-month calculation with UTC-aware date handling. Add a test that sets the database session timezone to a non-UTC zone and inserts rows on both sides of UTC midnight.

### pkg-shared-D5-003 — Google custom transport is bypassed by non-chat network methods

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `packages/model-runtime/src/providers/google/index.ts:95-116`, `packages/model-runtime/src/providers/google/index.ts:127-164`, `packages/model-runtime/src/providers/google/index.ts:299-385`, `packages/model-runtime/src/providers/google/index.ts:488-529`
- **Confidence:** HIGH
- **What:** The new `fetch` option says network methods execute through the enterprise SafeOutbound boundary, but only `chat` and `models` use `withTransport`.
- **Evidence:** The constructor stores `customFetch` in `boundFetch`, and `withTransport` binds it. `chat` and `models` call that wrapper. `createImage`, `createVideo`, `transcribe`, `handlePollVideoStatus`, and both `generateObject` branches call Google SDK helpers directly. No Google provider test supplies a custom fetch. Current in-repo SafeOutbound probing invokes `chat`, which limits today’s blast radius, but the exported constructor contract is still false for the other public methods.
- **Impact:** A caller that supplies a restricted/audited fetch and then performs image, video, transcription, polling, or structured-output work silently uses the SDK’s global transport instead. That can bypass outbound policy, test isolation, proxying, or request instrumentation.
- **Fix:** Route every public network method through `withTransport`, extracting private unbound implementations where necessary. Add one transport-spy test per method family proving the supplied fetch is used and global fetch is not.

### pkg-shared-D2-002 — New SuperGrok runtime and registration have no direct regression coverage

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `packages/model-runtime/src/providers/superGrok/index.ts:24-44`, `packages/model-runtime/src/runtimeMap.ts:151`, `packages/model-bank/src/aiModels/superGrok.ts:9-34`
- **Confidence:** HIGH
- **What:** The fork introduces a new authenticated provider, runtime-map entry, XAI payload reuse, model-list adapter, and model metadata without any provider-specific test.
- **Evidence:** A repository-wide search for `LobeSuperGrokAI`, `supergrok`, and `SuperGrok` in test/spec files under `model-runtime`, `model-bank`, and `const` returns no matches. Tests of the generic OpenAI-compatible factory and XAI provider do not verify the SuperGrok base URL, provider identity, registration key, model-list provider ID, or chat-only contract.
- **Impact:** A casing mismatch, missing runtime registration, wrong provider attribution, broken OAuth bearer propagation, or divergence from XAI payload rules can ship without detection and break the entire new provider flow.
- **Fix:** Add a dedicated provider test covering runtime-map resolution, base URL and bearer authentication, Chat Completions and Responses payload transformation, model-list normalization to `supergrok`, and the intentional absence of image/video capabilities.

### pkg-shared-D1-003 — Three fork-new stateful database models exceed the repository’s file-size guideline

- **Severity:** LOW
- **Dimension:** D1 Code smells
- **Location:** `packages/database/src/models/platform/auditExport.ts:1-1570`, `packages/database/src/models/platform/globalStats.ts:1-974`, `packages/database/src/models/platform/globalCredential.ts:1-901`
- **Confidence:** HIGH
- **What:** Three entirely fork-owned model files exceed the approximately 800-line split guideline. The largest combines several independently complex state machines.
- **Evidence:** `auditExport.ts` contains export CRUD, publication fencing, upload intents, legal-hold intersection, two-phase object deletion, purge outboxes, timeout probes, and dead-letter reconciliation. `globalStats.ts` combines date parsing, totals, ranks, heatmaps, raw pagination, SQL aggregation, and chart capping. `globalCredential.ts` combines validation, sequence repair, secret revisions, metadata CRUD, staged uploads, and consumption.
- **Impact:** Security- and data-lifecycle invariants are spread across large modules, increasing review cost and the risk of partial fixes or inconsistent tests—particularly around the Round-4 audit-export state machine.
- **Fix:** Split by invariant while keeping transaction boundaries explicit: for example, `auditExportLifecycle`, `auditExportPurgeOutbox`, and `auditExportReconciliation`; `globalStatsRanges`, `globalStatsUsage`, and `globalStatsCharts`; `globalCredentialSecrets` and `globalCredentialUploads`.

### pkg-shared-D3-001 — Test reset hook is exported from the device-control public API

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `packages/device-control/src/inlineSkillWorkspace.ts:181-187`, `packages/device-control/src/index.ts:3-4`, `packages/device-control/src/__tests__/inlineSkillWorkspace.test.ts:8-13`
- **Confidence:** HIGH
- **What:** `__resetInlineSkillWorkspacesForTests` is a test-only global-state mutation hook, but `export * from './inlineSkillWorkspace'` exposes it to every package consumer.
- **Evidence:** A repository-wide grep finds only its definition and the inline-workspace test import/call. There are no production callers, yet the barrel export makes it part of the package’s public surface.
- **Impact:** Internal test scaffolding appears in generated declarations and can be accidentally invoked by production consumers, clearing live workspace tracking and cancelling cleanup timers.
- **Fix:** Replace the wildcard barrel with explicit production exports that omit the reset hook, or move registry reset access to a test-only support module.

### pkg-shared-D4-001 — SuperGrok provider and model descriptions fall back to English in zh-CN

- **Severity:** LOW
- **Dimension:** D4 Missing Simplified Chinese i18n coverage
- **Location:** `packages/model-bank/src/modelProviders/superGrok.ts:12-20`, `packages/model-bank/src/aiModels/superGrok.ts:9-26`
- **Confidence:** HIGH
- **What:** Both new SuperGrok descriptions are hardcoded English, and no corresponding provider or `grok-4.5.description` translation exists in the locale sources or `locales/zh-CN`.
- **Evidence:** The model-detail UI calls `t('${model.id}.description', { ns: 'models', defaultValue: model.description })`; without a locale key, Simplified Chinese users receive the English default. Provider presentation follows the same translated-description-with-default pattern. Searches of locale sources and zh-CN resources found no SuperGrok or Grok 4.5 description keys.
- **Impact:** Chinese users see English descriptive copy in the provider and model selection surfaces introduced by the fork.
- **Fix:** Add and use these exact localized descriptions:
  - **en-US provider:** “Use Grok models with a SuperGrok or X Premium subscription. No API key is needed.”
  - **zh-CN provider:** “使用 SuperGrok 或 X Premium 订阅访问 Grok 模型，无需 API 密钥。”
  - **en-US model:** “xAI’s flagship model for coding, agentic tasks, and knowledge work, with adjustable reasoning effort.”
  - **zh-CN model:** “xAI 的旗舰模型，适用于编程、智能体任务和知识工作，并支持调节推理强度。”

### pkg-shared-D7-001 — Disable confirmation exposes “signed tombstone revision” implementation jargon

- **Severity:** LOW
- **Dimension:** D7 Overly technical / internal-state-leaking UI strings
- **Location:** `packages/locales/src/default/admin.ts:2028-2035`
- **Confidence:** HIGH
- **What:** The destructive identity-provider confirmation explains the operation using storage and replication terminology—“signed tombstone revision”, “instances reload”, and “republishing”—instead of describing the user-visible effect.
- **Evidence:** `identityProviders.disable.impact` is rendered in a confirmation modal. The current zh-CN translation mirrors the internal terminology as “已签名的墓碑修订”, which is not actionable language for an administrator.
- **Impact:** Administrators must understand internal revision/tombstone mechanics before they can judge a destructive sign-in change, weakening the DESIGN.md goals of natural language and certainty.
- **Fix:** Replace it with:
  - **en-US:** “Disabling this sign-in method stops new logins after all running instances reload. To restore it later, publish a new configuration.”
  - **zh-CN:** “停用此登录方式后，所有运行中的实例重新加载时将停止新的登录。若以后需要恢复，请发布新配置。”

## Dimensions with no findings

- **D6 Warnings and errors not surfaced via toast:** Reviewed fork-owned mutation/error paths in database models, TRPC context, model transports, OpenAPI helpers, and device cleanup. User-action failures in these package layers are propagated or returned to their UI callers; no verified fork-owned interactive failure was silently converted into success. The internal TTL cleanup failure is reported under D1 because it is maintenance cleanup rather than an actionable UI mutation.
- **D8 Missing animations / motion:** The scoped delta contains no TSX files or interactive panels, lists, dialogs, loading surfaces, or state-transition components. Motion decisions therefore belong to consuming UI paths outside this assignment.

## Cross-scope notes

- `src/enterprise/client/features/admin/identityProviders/IdentityProviderPage.tsx:133-149` duplicates the “signed tombstone revision” text as `defaultValue`. It must be updated with the D7 locale copy or the jargon will reappear when translation loading fails.
- `src/enterprise/client/features/admin/audit/exports/ExportsPage.tsx:315-324` falls back to rendering `detail.error.code` verbatim when a translation is missing. New or unexpected export failures can therefore expose internal codes directly to administrators.
