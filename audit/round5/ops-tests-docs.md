# Round 5 Audit — ops-tests-docs

## Scope

Audited the baseline-to-`HEAD` delta for:

- `scripts/enterprise` — 139 current files
- `packages/database/migrations` — 7
- `e2e` — 56
- `docs/enterprise` and `docs/self-hosting` — 44
- `docker-compose` — 6
- `locales` — 26
- `tests` — 6
- `package.json` — 1

The delta contains 517 path records: 220 additions, 65 modifications, and 232 deletions. There are 285 files present at `HEAD`, with 67,399 added and 1,148,985 deleted lines.

`knip.ts` and `eslint-suppressions.json` are byte-identical to baseline and were excluded. Out-of-scope callers were consulted only where needed to verify fork-seam behavior.

## Summary

| Dimension                           | Findings | Highest severity |
| ----------------------------------- | -------: | ---------------- |
| D1 Code smells                      |        3 | HIGH             |
| D2 Test decay                       |        2 | HIGH             |
| D3 Dead code and development debris |        1 | MEDIUM           |
| D4 Missing Simplified Chinese i18n  |        1 | MEDIUM           |
| D5 Potential functional bugs        |        4 | HIGH             |
| D6 Errors not surfaced via toast    |        0 | —                |
| D7 Technical/internal UI strings    |        1 | LOW              |
| D8 Missing animations/motion        |        0 | —                |

## Findings

### ops-tests-docs-D5-001 — The migration compatibility verifier cannot pass against the current migration chain

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `scripts/enterprise/verify-migration/constants.ts:5-11`; `scripts/enterprise/verify-migration/baseline.ts:104-231`; `scripts/enterprise/verify-migration/migrations.ts:223-227`; `scripts/enterprise/verify-migration/runner.ts:127-165`; `packages/database/migrations/meta/_journal.json:5-24`; `package.json:93`
- **Confidence:** HIGH
- **What:** The verifier still requires the original 117 migrations through `0116` to remain byte-identical at `HEAD`, even though the fork replaced them with a squashed baseline and two follow-ups. It also classifies migrations by `idx > 116`, so all three current entries—indices 0, 2, and 11—are considered baseline migrations and the expand-only check scans nothing.
- **Evidence:** `BASELINE_MIGRATION_COUNT` remains 117 and `BASELINE_LAST_TAG` remains `0116_add_task_connector_message_and_verify_updates`. `verifyBaselineMigrationsMatch` compares the current migration directory with the baseline commit and indexes directly into 117 expected journal entries. `postBaselineEntries` filters solely on `idx > 116`. A read-only invocation against the repository returned:
  - `baseline.match = "failed"`
  - reasons including `baseline-file-hash-mismatch`, `missing-local-baseline-file`, `baseline-journal-tag-mismatch`
  - `journal.match = false`
  - `expand.scannedMigrations = 0`
    `runner.ts` then fails the static gate before creating its disposable database.
- **Impact:** `bun run enterprise:verify-migration` always exits unsuccessfully and never proves either fresh-install or v2.2.10 upgrade compatibility. A release gate added specifically to protect database upgrades is unusable.
- **Fix:** Separate the historical v2.2.10 fixture from the active migration chain. Materialize historical migrations from the pinned Git ref in a temporary fixture, treat `0000_squash_baseline` as the active fresh-install baseline, and identify follow-ups by journal order or explicit tags rather than `idx > 116`. Add a test that executes the verifier against the real repository layout.

### ops-tests-docs-D2-001 — Migration tests assert the deleted 117-file layout, while the real integration lane is never enabled

- **Severity:** HIGH
- **Dimension:** D2 Test decay
- **Location:** `scripts/enterprise/verify-migration.test.ts:104-125`; `scripts/enterprise/verify-migration.integration.test.ts:39-50`; `package.json:55-58,93`
- **Confidence:** HIGH
- **What:** The unit suite contains three assertions that are false for the checked-in migration chain, while the Docker integration suite is skipped unless an environment variable is manually supplied.
- **Evidence:** The unit test requires a passing 117-migration baseline, at least 117 journal entries, and more than zero post-baseline migrations. The repository has three journal entries and the verifier reports zero post-baseline migrations. The integration suite uses `describe.skipIf(!enabled)`, where `enabled` requires `MIGRATION_COMPAT_INTEGRATION=1`. Repo-wide search found that variable only in this test; no package script or workflow sets it.
- **Impact:** If the unit test is discovered, it fails deterministically. If it is omitted, the critical full-chain migration proof remains dormant. Round‑4’s remediation therefore did not leave a reliable regression gate.
- **Fix:** Rewrite the unit expectations around the squashed chain, add non-vacuous follow-up scanning assertions, and wire a dedicated Docker CI job that sets `MIGRATION_COMPAT_INTEGRATION=1`. Fail the job if the integration suite reports skipped tests.

### ops-tests-docs-D5-002 — Drizzle migration snapshots are empty placeholders with a broken ancestry chain

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `packages/database/migrations/meta/0000_snapshot.json:1-11`; `packages/database/migrations/meta/0002_snapshot.json:1-11`; `packages/database/migrations/meta/0011_snapshot.json:1-11`; `packages/database/migrations/0000_squash_baseline.sql:1-30`; `package.json:57`
- **Confidence:** HIGH
- **What:** All three snapshots claim the database contains no tables, enums, schemas, or sequences. Both follow-up snapshots point directly to the all-zero baseline ID instead of chaining to their immediate predecessor.
- **Evidence:** Every snapshot contains `"tables": {}` and empty metadata. `0011_snapshot.json` has `prevId: "00000000-..."` rather than the ID of `0002_snapshot.json`. In contrast, the baseline SQL contains 174 `CREATE TABLE` statements, and the active schema source defines 165 `pgTable` declarations.
- **Impact:** The next `drizzle-kit generate` can treat the latest snapshot as an empty database and emit a migration recreating the existing schema, producing duplicate-object failures or an unusable migration. Runtime migration application may work today, but normal schema evolution is unsafe.
- **Fix:** Regenerate all snapshots from the actual Drizzle schema using the repository migration workflow, preserving a proper `prevId` chain. Add validation that snapshots contain representative core tables and that each non-root snapshot references the previous snapshot ID.

### ops-tests-docs-D5-003 — The squashed baseline commits in the middle of the migration

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `packages/database/migrations/0000_squash_baseline.sql:1168-1174`; `packages/database/migrations/0000_squash_baseline.sql:1388-1405`; `packages/database/migrations/0000_squash_baseline.sql:7565-7586`; `package.json:58`
- **Confidence:** HIGH
- **What:** The migration includes an internal `BEGIN` at line 1172 and `COMMIT` at line 1393, followed by over six thousand lines of additional DDL. That transaction control interferes with the transaction used by the official migrator.
- **Evidence:** The baseline literally contains `BEGIN;`, performs a historical user-ID migration, issues `COMMIT;`, and then continues with later migrations through the final trigger definition. The database bootstrap caller’s preflight documentation explicitly acknowledges that this inner commit ends the migrator transaction and may leave DDL committed without a migration-journal row.
- **Impact:** A fresh installation that fails after the embedded commit can be left with a partially created schema but no recorded baseline migration. Retrying then collides with already-created objects, breaking the core installation flow and requiring destructive recovery.
- **Fix:** Regenerate the baseline as final-state DDL without any top-level `BEGIN`, `COMMIT`, or historical data-migration transaction. Add a static test requiring zero transaction-control statements in migration bodies and validate failure rollback using a disposable database.

### ops-tests-docs-D1-001 — The “online” index predeploy is undone by the migration itself

- **Severity:** HIGH
- **Dimension:** D1 Code smells
- **Location:** `packages/database/migrations/0002_r4_w1_evidence.sql:5-25`; `packages/database/migrations/0011_r4_w2_db.sql:3-36`; `docs/self-hosting/advanced/database-retention-indexes-predeploy.md:3-35`
- **Confidence:** HIGH
- **What:** Five hot-path indexes are built with ordinary `CREATE INDEX` inside migrations. The runbook advises creating three concurrently first, but `0011` unconditionally drops one of those prebuilt indexes before recreating it non-concurrently.
- **Evidence:** The runbook says that after `CREATE INDEX CONCURRENTLY`, migration `0011` is a no-op because of `IF NOT EXISTS`. However, lines 28–29 execute `DROP INDEX IF EXISTS "platform_audit_exports_purge_outbox_updated_at_id_idx"` immediately before recreating it. The two indexes in `0002` have no concurrent predeploy instructions at all.
- **Impact:** Even operators who follow the documented online procedure can incur a blocking index build on populated `topics` or `platform_audit_exports` tables. Under normal production load this can stall writes and cause request timeouts.
- **Fix:** Use new index names for corrected predicates, prebuild them with `CREATE INDEX CONCURRENTLY`, verify `pg_index.indisvalid`, and only then retire obsolete indexes through a non-transactional deployment step. Add all five indexes to an enforced predeploy gate; do not rely on advisory documentation.

### ops-tests-docs-D1-002 — The “squashed” baseline replays obsolete schema history instead of expressing final state

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `packages/database/migrations/0000_squash_baseline.sql:442-465`; `packages/database/migrations/0000_squash_baseline.sql:1033-1042`; `packages/database/migrations/0000_squash_baseline.sql:1168-1395`
- **Confidence:** HIGH
- **What:** The baseline is a concatenation of historical migrations, including objects that are created and subsequently removed and data-backfill logic that is unnecessary on an empty database.
- **Evidence:** It creates `user_budgets` and `user_subscriptions` beginning at line 465, then drops them at lines 1034–1035. It similarly creates constraints and indexes only to replace them in later embedded phases. Historical phase headers such as `0001`, `0002`, and `0017` remain throughout the 7,586-line file.
- **Impact:** Fresh installs perform avoidable DDL, acquire extra locks, and inherit historical ordering assumptions. The resulting migration is harder to review and materially more likely to fail halfway through.
- **Fix:** Generate a true final-state baseline from the current schema, retaining only DDL required for the final database state and explicit seed/backfill operations that fresh installations genuinely need.

### ops-tests-docs-D2-002 — Real Prometheus and OTLP compatibility tests are permanently skipped in automated checks

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `scripts/enterprise/prometheus-alerts/checkRules.integration.test.ts:1-28`; `scripts/enterprise/prometheus-alerts/checkRules.integration.test.ts:30-97`; `package.json:55,86-90`
- **Confidence:** HIGH
- **What:** The only tests that invoke real `promtool`, start the pinned Prometheus runtime, validate the collector image, and exercise OTLP-to-Prometheus translation are behind an opt-in `describe.skip`.
- **Evidence:** `describeIntegration` resolves to `describe.skip` unless `ENTERPRISE_PROM_INTEGRATION=1`. Repo-wide search found no workflow or package command that sets this variable. The root `check` script runs branding, path-boundary, and generic checks but does not invoke this integration lane.
- **Impact:** Invalid runtime flags, incompatible pinned images, collector configuration failures, or changed OTLP label translation can reach deployment while the hermetic unit suite remains green.
- **Fix:** Add a scheduled and release/label-gated CI job that sets `ENTERPRISE_PROM_INTEGRATION=1`, runs this exact test file with Docker, and rejects skipped results. Keep the existing hermetic suite for ordinary PR latency.

### ops-tests-docs-D3-001 — Fork documentation contradicts active CI and migration state

- **Severity:** MEDIUM
- **Dimension:** D3 Dead code and development debris
- **Location:** `e2e/enterprise-admin/playwright.config.ts:3-6`; `e2e/enterprise-admin/README.md:9-15,76-79`; `e2e/enterprise-admin/CI.md:3-17`; `docs/enterprise/reference/database-tables.md:130-137`; `packages/database/migrations/meta/_journal.json:5-24`
- **Confidence:** HIGH
- **What:** Round‑4 left mutually contradictory documentation about whether enterprise-admin E2E runs in shared CI, while the database reference still says the journal contains only the baseline migration.
- **Evidence:** `playwright.config.ts` and the README say the suite is not referenced by shared workflows and that wiring it is a non-goal. `CI.md` says it is wired by `enterprise-admin-gates.yml` and lists active jobs. The database reference says “journal 仅此一条，” but `_journal.json` contains `0000`, `0002`, and `0011`.
- **Impact:** Maintainers can incorrectly assume critical E2E is opt-in, duplicate or bypass its workflow, or use an obsolete migration model when preparing upgrades.
- **Fix:** Make `CI.md` the authoritative E2E description and update/remove the stale README and config comments. Change the database reference to describe the squashed baseline plus ordered follow-ups, linking to `_journal.json` instead of copying a fixed count.

### ops-tests-docs-D4-001 — Twelve fork-added English locale keys have no zh-CN counterpart

- **Severity:** MEDIUM
- **Dimension:** D4 Missing Simplified Chinese i18n coverage
- **Location:** `locales/en-US/chat.json:203-204`; `locales/zh-CN/chat.json:201-204`; `locales/en-US/modelProvider.json:241-256`; `locales/zh-CN/modelProvider.json:240-256`; `locales/en-US/models.json:684-709`; `locales/zh-CN/models.json:683-706`; `locales/en-US/providers.json:67`; `locales/zh-CN/providers.json:66-67`; `locales/en-US/setting.json:783-790,2635-2639`; `locales/zh-CN/setting.json:783-790,2634-2637`
- **Confidence:** HIGH
- **What:** Parsed JSON key-set comparison found 12 keys present in en-US but absent from zh-CN. The fork also explicitly deleted existing Chinese `reasoningMode` and graph-placeholder translations while retaining or updating their English keys.
- **Evidence:** Missing keys are the two reasoning-mode labels, three model-provider hints, four model descriptions, the SuperGrok description, the graph placeholder, and the workspace Connector tab.
- **Impact:** Chinese users see English fallbacks or raw keys in model settings, provider selection, graph configuration, and workspace navigation.
- **Fix:** Add these exact pairs:

| Key                                        | en-US                                                                                                                                 | zh-CN                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `extendParams.reasoningMode.desc`          | Standard balances speed and cost. Pro performs more model work for difficult tasks and may use more tokens.                           | 标准模式兼顾速度与成本；Pro 模式会为复杂任务投入更多推理，可能消耗更多 Token。                              |
| `extendParams.reasoningMode.title`         | Reasoning Mode                                                                                                                        | 推理模式                                                                                                    |
| `...gpt5_6ReasoningEffort.hint`            | For GPT-5.6 series; controls reasoning intensity from None through Max.                                                               | 适用于 GPT-5.6 系列；控制从 “无” 到 “最大” 的推理强度。                                                     |
| `...grok4_5ReasoningEffort.hint`           | For Grok 4.5 series; controls reasoning intensity (low/medium/high, default high).                                                    | 适用于 Grok 4.5 系列；控制推理强度（低 / 中 / 高，默认为高）。                                              |
| `...reasoningMode.hint`                    | For GPT-5.6 Responses API; switches between Standard and Pro reasoning modes.                                                         | 适用于 GPT-5.6 Responses API；可在标准与 Pro 推理模式之间切换。                                             |
| `gpt-5.6-luna.description`                 | GPT-5.6 Luna is optimized for cost-sensitive, high-volume workloads with the lowest price in the GPT-5.6 family.                      | GPT-5.6 Luna 针对成本敏感的高吞吐工作负载进行了优化，是 GPT-5.6 系列中价格最低的型号。                      |
| `gpt-5.6-sol.description`                  | GPT-5.6 Sol is OpenAI's frontier model for complex reasoning, coding, and long-horizon agentic work. The gpt-5.6 alias routes to Sol. | GPT-5.6 Sol 是 OpenAI 面向复杂推理、编程和长周期智能体任务的前沿模型；gpt-5.6 别名会路由到 Sol。            |
| `gpt-5.6-terra.description`                | GPT-5.6 Terra balances intelligence and cost for everyday professional work, competitive with GPT-5.5 at about half the price.        | GPT-5.6 Terra 在智能与成本之间取得平衡，适合日常专业工作；能力可媲美 GPT-5.5，价格约为其一半。              |
| `grok-4.5.description`                     | SpaceXAI's flagship model for coding, agentic tasks, and knowledge work — configurable reasoning (low/medium/high, always on).        | Grok 4.5 是 SpaceXAI 面向编程、智能体任务和知识工作的旗舰模型；支持低、中、高三档推理强度，且始终启用推理。 |
| `supergrok.description`                    | Access Grok models with your SuperGrok or X Premium subscription, no API key required.                                                | 使用 SuperGrok 或 X Premium 订阅访问 Grok 模型，无需 API Key。                                              |
| `settingGraphRuntime.snapshot.placeholder` | Paste a ReasoningGraph JSON snapshot, for example: `{"name":"...","nodes":{...},"terminal":"...","edges":[]}`                         | 粘贴 ReasoningGraph JSON 快照，例如：`{"name":"...","nodes":{...},"terminal":"...","edges":[]}`             |
| `workspaceSetting.tab.connector`           | Connectors                                                                                                                            | 连接器                                                                                                      |

### ops-tests-docs-D5-004 — E2E seed mutation can overwrite and later restore a stale global policy

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `e2e/enterprise-admin/support/seed/seedTransaction.ts:82-101,309-353`; `e2e/enterprise-admin/scripts/preflight.ts:73-81`; `e2e/enterprise-admin/support/seed/casRestore.ts:33-93`
- **Confidence:** HIGH
- **What:** The seed records `skillsBefore` before opening its transaction, then updates the policy without comparing the row’s current revision or contents. Restoration is CAS-protected, but the initial mutation is not.
- **Evidence:** `globalBefore` is captured at line 82; the transaction begins only at line 117. The update predicate is merely `WHERE id = $3 AND resource = 'skills'`, while the restore path correctly compares revision, enforcement, status, and configuration. The manifest records the older `skillsBefore`, not the row read immediately before mutation.
- **Impact:** A concurrent update between the initial snapshot and seed update can be overwritten. Cleanup may then restore the still-older snapshot, losing both concurrent and immediately preceding state. Exposure is limited to E2E databases, but external mode relies only on a self-asserted disposable-database flag.
- **Fix:** Begin the transaction first, read the policy with `SELECT ... FOR UPDATE`, derive `before` from that locked row, and include every compared field in the mutation’s `WHERE` clause. Add a barrier-based test that changes the policy between the initial digest and seed mutation.

### ops-tests-docs-D1-003 — Seven new audit/support files exceed the repository’s 800-line split guideline

- **Severity:** LOW
- **Dimension:** D1 Code smells
- **Location:** `scripts/enterprise/security-acceptance/security-acceptance.test.ts:1-1732`; `scripts/enterprise/upstream-rebase-ci/upstream-rebase-ci.test.ts:1-1135`; `scripts/enterprise/production-readiness/recovery/invariants.ts:1-1113`; `scripts/enterprise/pathBoundaries.ts:1-953`; `scripts/enterprise/brandingLiterals.ts:1-915`; `e2e/enterprise-admin/support/lifecycle.ts:1-905`; `scripts/enterprise/production-readiness/schemas.ts:1-868`
- **Confidence:** HIGH
- **What:** These added files exceed the project’s approximate 800-line threshold, and several combine unrelated responsibilities.
- **Evidence:** `invariants.ts` combines digest encoding, table scans, secret-reference checks, publication checks, and manifest building. `brandingLiterals.ts` combines file classification, AST evaluation, scanning, and baseline validation. `lifecycle.ts` combines process enumeration, port checks, Docker ownership, signal handling, and cleanup.
- **Impact:** Changes to unrelated concerns collide in the same modules, increasing review cost and regression risk in already safety-sensitive operational code.
- **Fix:** Split by responsibility—for example, digest/table invariants, secret invariants, publication invariants; branding policy versus scanner; process, Docker, and signal lifecycle; and one schema module per evidence domain.

### ops-tests-docs-D7-001 — Conflict and identity-provider confirmations expose revision-control and tombstone jargon

- **Severity:** LOW
- **Dimension:** D7 Overly technical/internal-state-leaking UI strings
- **Location:** `locales/en-US/admin.json:1389-1404,1736-1746`; `locales/zh-CN/admin.json:1389-1404,1736-1746`
- **Confidence:** HIGH
- **What:** Visible banners and confirmation dialogs use “rebase,” “path-level collisions,” “server revision,” and “signed tombstone revision.” These describe persistence and concurrency internals instead of the user’s choice and outcome.
- **Evidence:** The strings are rendered by the settings conflict banner and identity-provider disable/delete confirmations. In particular, disabling a login method tells administrators that it “publishes a signed tombstone revision.”
- **Impact:** Administrators must understand source-control and database terminology to decide whether an action is safe, weakening the design goals of certainty and meaningful action.
- **Fix:** Replace the affected copy with:

| Key                                         | en-US                                                                                                                                                     | zh-CN                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `settingsPolicy.conflict.latestUnavailable` | The latest saved settings could not be loaded. Your changes are safe; try again before keeping or discarding them.                                        | 无法加载最新保存的设置。你的更改仍然安全；请先重试，再决定保留或放弃。                     |
| `settingsPolicy.conflict.noCollisions`      | Your changes do not overlap with the latest saved settings and can be kept safely.                                                                        | 你的更改与最新保存的设置没有重叠，可以安全保留。                                           |
| `settingsPolicy.conflict.rebase`            | Keep my changes                                                                                                                                           | 保留我的更改                                                                               |
| `settingsPolicy.conflict.refresh`           | Load latest settings                                                                                                                                      | 加载最新设置                                                                               |
| `settingsPolicy.conflict.retryRefresh`      | Retry loading latest settings                                                                                                                             | 重试加载最新设置                                                                           |
| `settingsPolicy.conflict.revisions`         | Your changes started from version {{local}}; the latest saved version is {{server}}.                                                                      | 你的更改基于版本 {{local}}；最新保存版本为 {{server}}。                                    |
| `settingsPolicy.conflict.title`             | These settings changed while you were editing. Review the latest version, then keep or discard your changes.                                              | 你编辑期间，这些设置已被更新。请先查看最新版本，再决定保留或放弃你的更改。                 |
| `identityProviders.delete.impact`           | This permanently deletes a draft that has never been published. If the sign-in method is already in use, disable it instead.                              | 这会永久删除从未发布的草稿。如果此登录方式已投入使用，请改用 “停用”。                      |
| `identityProviders.disable.impact`          | This disables the sign-in method for everyone. New logins will stop after the change finishes applying. To restore it later, publish a new configuration. | 这会为所有人停用此登录方式。更改完成应用后，它将不再接受新登录。若要恢复，请发布新的配置。 |

## Dimensions with no findings

- **D6 Warnings and errors not surfaced via toast:** The assigned fork-owned paths contain no production interactive UI mutation handlers. Operational scripts consistently communicate failure through non-zero exits and structured CLI output; toast behavior belongs to callers outside this scope.
- **D8 Missing animations / motion:** No production UI components or state-transition implementations were added within the assigned paths. Locale resources, E2E assertions, migrations, scripts, and documentation cannot themselves implement motion, so no upstream UI-library animation change is warranted.
