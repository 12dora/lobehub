# Round 5 Audit — srv-agent-skill-catalog

## Scope

Audited:

- `apps/server/src/enterprise/services/agentCatalog`
- `apps/server/src/enterprise/services/skillCatalog`

The delta contains 65 fork-owned files: 29 production modules, 3 shared test fixtures, and 33 test files. Relative to `4bab1636408e60a7ee17b640490fbf33a310a325`, the scope adds 19,557 LOC with no deletions. No files were excluded as upstream-identical because every file is fork-added.

Round-4 commit `4f68061410` modified 27 files in scope; the other listed Round-4 remediation commits did not touch these paths. This was a static, read-only audit; tests were not executed.

## Summary

| Dimension                                             | Findings | Highest severity |
| ----------------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                        |        2 | HIGH             |
| D2 Test decay                                         |        1 | MEDIUM           |
| D3 Dead code and development debris                   |        1 | LOW              |
| D4 Missing zh-CN i18n coverage                        |        1 | LOW              |
| D5 Potential functional bugs                          |        1 | HIGH             |
| D6 Warnings and errors not surfaced via toast         |        1 | MEDIUM           |
| D7 Overly technical/internal-state-leaking UI strings |        1 | LOW              |
| D8 Missing animations/motion                          |        0 | —                |

## Findings

### srv-agent-skill-catalog-D1-001 — Published Skill caching multiplies full payloads without an aggregate byte bound

- **Severity:** HIGH
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/services/skillCatalog/readService.ts:63-92`, `apps/server/src/enterprise/services/skillCatalog/readService.ts:293-349`, `apps/server/src/enterprise/services/skillCatalog/readService.ts:353-368`, `apps/server/src/enterprise/services/skillCatalog/runtimeSnapshot.ts:84-106`
- **Confidence:** HIGH
- **What:** The catalog is bounded by item count, but not by aggregate payload size. Every resolved Skill—including full instruction and resource content—is deep-cloned into the execution index, cloned again into the global revision cache, and cloned once more into each new service instance.
- **Evidence:** `MAX_PUBLISHED_SKILLS` permits 10,000 items. `cloneExecutionIndex()` applies `structuredClone` to every resolved Skill. Projection creation first clones each resolved value at line 329 and then calls `cloneExecutionIndex(executionIndex)` at line 341. Every `getPublishedCatalog()` subsequently clones the complete cached index into `this.publishedExecutionIndex` at line 366. `projectionByRevision` retains up to 32 such projections. Runtime snapshot construction creates a new read service and may then expand resource content into prompts for every selected Skill.
- **Impact:** Catalog growth or a set of resource-heavy Skills can produce large CPU spikes and process OOMs during ordinary runtime startup. Even a 100 MB execution index is duplicated per projection and per request-level service; the 10,000-item and 32-revision limits make count-bounded retention insufficient.
- **Fix:** Add an aggregate byte budget for published and operation-level catalogs. Store a frozen/read-only execution index once and clone only the single resolved Skill returned to a caller. Bound `projectionByRevision` by byte weight as well as entry count, and add realistic large-payload regression tests that assert clone count and retained size.

### srv-agent-skill-catalog-D5-001 — Corrupt mandatory Skills are silently removed while the catalog is marked healthy

- **Severity:** HIGH
- **Dimension:** D5 Potential functional bugs
- **Location:** `apps/server/src/enterprise/services/skillCatalog/readService.ts:232-267`, `apps/server/src/enterprise/services/skillCatalog/readService.ts:293-332`, `apps/server/src/enterprise/services/skillCatalog/readService.projection.test.ts:132-174`
- **Confidence:** HIGH
- **What:** A published Skill that fails `serverResolvedSkillSchema.parse()` is dropped with `continue`. Because the readiness calculation only considers surviving `skills`, the projection can still be marked execution-ready even when the omitted Skill was configured as mandatory.
- **Evidence:** Lines 237-255 catch every parse failure and continue without recording an invalid item. Lines 269-281 construct the public catalog only from successfully parsed entries. Readiness is then `executionReady && executionIndex.size === skills.length`, which is true when all survivors are indexed. The regression test deliberately corrupts a published Skill and asserts that only `healthy.skill` remains, but does not assert unavailable/degraded readiness or mandatory behavior.
- **Impact:** Legacy corruption or stale resource metadata can silently remove an organization-mandated Skill from new operations while runtime health reports success. Users receive a reduced policy/runtime configuration with no indication that enforcement is incomplete.
- **Fix:** Preserve a projection failure record for every current authority item. At minimum, any skipped mandatory Skill must make the runtime projection unavailable. Optional/default corrupt Skills may be isolated for availability, but must produce degraded health and an observable diagnostic rather than disappearing. Add regression coverage for corrupt mandatory, default, and optional distributions plus runtime reporting.

### srv-agent-skill-catalog-D2-001 — Five real-PostgreSQL regression suites are gated but never scheduled by CI

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `apps/server/src/enterprise/services/agentCatalog/adminService.pg.test.ts:32`, `apps/server/src/enterprise/services/agentCatalog/adminService.constraints.pg.test.ts:45`, `apps/server/src/enterprise/services/agentCatalog/dependencyLock.pg.test.ts:17`, `apps/server/src/enterprise/services/agentCatalog/effectiveResolver.pg.test.ts:45`, `apps/server/src/enterprise/services/agentCatalog/effectiveResolver.f5.pg.test.ts:1-8`, `apps/server/src/enterprise/services/agentCatalog/effectiveResolver.f5.pg.test.ts:72-74`, `.github/workflows/enterprise-failure-drills.yml:95-116`
- **Confidence:** HIGH
- **What:** Critical PostgreSQL-only suites skip unless `TEST_SERVER_DB=1`, but the only workflow providing that environment explicitly executes just the materialization and rollout suites.
- **Evidence:** The five listed suites use `describe.skip` or `describe.skipIf` when the environment flag is absent. The failure-drills workflow invokes `materialization.multiconn.pg.test.ts` and `rolloutService.multiconn.pg.test.ts`, but none of these five. The F5 file additionally claims it runs against PGlite by default at lines 4-5, contradicting its real-Postgres-only `skipIf` at line 72.
- **Impact:** The production `DISTINCT ON` winner query, cursor semantics, constraint normalization, advisory-lock protocol, and admin concurrency behavior can regress while all required CI checks remain green. These are precisely the areas covered by prior remediation.
- **Fix:** Add all five suites to the real-PostgreSQL CI job, preferably with isolated databases and `fileParallelism=false`. Correct the F5 header comment or add a smaller always-on PGlite variant while retaining the large real-PostgreSQL scale test.

### srv-agent-skill-catalog-D6-001 — Cache invalidation failures still produce unconditional publication-success UI

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `apps/server/src/enterprise/services/agentCatalog/publication.ts:89-105`, `apps/server/src/enterprise/services/agentCatalog/publication.ts:208-210`, `apps/server/src/enterprise/services/agentCatalog/rolloutService.ts:773-787`, `apps/server/src/enterprise/services/agentCatalog/publication.test.ts:149-160`, `src/enterprise/client/features/admin/agents/useAgentActions.tsx:244-259`
- **Confidence:** HIGH
- **What:** Post-commit invalidation failures are logged and discarded. The service returns the same success shape, so the client always shows “published” or “rolled back” even though other instances may continue serving stale catalog/runtime state.
- **Evidence:** `invalidate()` catches publisher rejection and returns `void`; publish then records a successful observation and returns normally. Rollout rollback repeats the same pattern. The regression test explicitly expects a rejected invalidation publisher to yield a success result with `outcome: 'success'`. The caller unconditionally invokes `toast.success`.
- **Impact:** An administrator is told the change is active while multi-instance readers may continue using the old Agent configuration until cache expiry or another invalidation. Immediate verification or execution can therefore observe the wrong version.
- **Fix:** Preserve successful commit semantics, but return an `invalidationStatus: 'delivered' | 'deferred'` field. On `deferred`, use `Toast.warning` from `@lobehub/ui/base-ui`, for example: “Agent published, but some servers are still refreshing. Wait a moment before starting new runs.” Keep retry/monitoring server-side rather than turning the committed mutation into an error.

### srv-agent-skill-catalog-D1-002 — Two fork-owned modules exceed the repository’s file-size guideline and mix several responsibilities

- **Severity:** LOW
- **Dimension:** D1 Code smells
- **Location:** `apps/server/src/enterprise/services/agentCatalog/rolloutService.ts:1-816`, `apps/server/src/enterprise/services/skillCatalog/validator.ts:1-810`
- **Confidence:** HIGH
- **What:** Both files exceed the repository’s approximately 800-line split threshold and combine independent responsibilities.
- **Evidence:** `rolloutService.ts` contains persistence schemas, status mapping, queue insertion, control transitions, listing, launch, rollback proof, publication-pointer mutation, audit, and invalidation. `validator.ts` contains text-security heuristics, Unicode/canonicalization checks, permissions validation, graph traversal/batching, cycle detection, resource validation, and issue aggregation.
- **Impact:** Changes to one policy area require reviewing large unrelated state machines, increasing regression risk in already remediation-heavy code.
- **Fix:** Split rollout schemas/projection, queue control, and rollback orchestration into focused modules. Split validator instruction scanning, dependency-graph validation, resource validation, and issue collection while preserving one public `SkillCatalogValidator` façade.

### srv-agent-skill-catalog-D3-001 — Skill admin failure auditing retains a stray `console.error`

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `apps/server/src/enterprise/services/skillCatalog/adminService.ts:208-225`
- **Confidence:** HIGH
- **What:** Failure-audit fallback uses `console.error` instead of the repository’s namespaced debug/observability mechanism.
- **Evidence:** Lines 220-223 emit `[admin.skills] failure audit append failed` directly to the console. The sibling Agent admin service uses the `debug` package and `lobe-server:platform-agent-admin` namespace for the same best-effort failure path.
- **Impact:** Logging behavior differs between equivalent catalog services, cannot be controlled consistently through `DEBUG`, and leaves development-style console output in production code.
- **Fix:** Add a `debug('lobe-server:skill-catalog-admin')` logger and emit only the low-cardinality error class, matching the Agent catalog pattern.

### srv-agent-skill-catalog-D4-001 — zh-CN still exposes English-only server diagnostics in Skill validation details

- **Severity:** LOW
- **Dimension:** D4 Missing Simplified Chinese (zh-CN) i18n coverage
- **Location:** `apps/server/src/enterprise/services/skillCatalog/validator.ts:102-107`, `apps/server/src/enterprise/services/skillCatalog/validator.ts:196-208`, `apps/server/src/enterprise/services/skillCatalog/validator.ts:212-329`, `apps/server/src/enterprise/services/skillCatalog/validator.ts:347-598`, `apps/server/src/enterprise/services/skillCatalog/validator.ts:623-803`, `src/enterprise/client/features/admin/skills/VersionsSection.tsx:260-266`
- **Confidence:** HIGH
- **What:** Validation issues contain hardcoded English `message` values. Although the primary issue-code summary is localized, the admin UI renders the raw server message under an expandable details section in every locale.
- **Evidence:** `issue()` accepts and persists arbitrary English messages such as “Skill dependency graph exceeds validation limits” and “Managed Skill runtime requires inline content.” `VersionsSection` renders `issue.message` verbatim at line 265. The zh-CN locale only translates the issue-code summary, not these server diagnostics.
- **Impact:** Chinese administrators encounter mixed-language validation output, particularly when opening details to diagnose a failure.
- **Fix:** Stop exposing free-form server messages in the UI contract and use the existing localized issue-code mapping. Replace the details body with exact localized copy:
  - **en-US:** “Use the validation message above. If you need support, provide reference code {{code}}.”
  - **zh-CN:** “请先按照上方校验提示处理。如需支持，请提供参考代码 {{code}}。”

### srv-agent-skill-catalog-D7-001 — Platform Agent failures expose encoded identities and catalog jargon to ordinary users

- **Severity:** LOW
- **Dimension:** D7 Overly technical / internal-state-leaking UI strings
- **Location:** `apps/server/src/enterprise/services/agentCatalog/userListProjection.ts:167-176`, `apps/server/src/enterprise/services/agentCatalog/platformAgentExecutionResolver.ts:151-173`, `apps/server/src/enterprise/services/agentCatalog/platformAgentExecutionResolver.ts:227-269`, `apps/server/src/enterprise/services/agentCatalog/platformAgentExecutionResolver.ts:331-358`
- **Confidence:** HIGH
- **What:** User-facing TRPC errors interpolate the internal list identifier and use phrases such as “Platform agent dependencies are unavailable.”
- **Evidence:** List identities are encoded from `platformAgentId`; multiple failure branches return `Agent not found: ${identifier}`, which can expose values such as `platform-agent:pagt_…`. Dependency failures surface implementation vocabulary rather than an actionable next step.
- **Impact:** Ordinary users see catalog IDs and dependency terminology they cannot act on, contrary to the product’s control-first copy guidance.
- **Fix:** Never interpolate the identifier. Use:
  - **Unavailable Agent — en-US:** “This Agent is no longer available. Return to the Agent list and choose another.”
  - **Unavailable Agent — zh-CN:** “此 Agent 已不可用。请返回 Agent 列表并选择其他 Agent。”
  - **Missing resource — en-US:** “This Agent can’t start because a required resource is unavailable. Ask an administrator to review its setup.”
  - **Missing resource — zh-CN:** “此 Agent 无法启动，因为所需资源不可用。请联系管理员检查其设置。”
  - **Generic start failure — en-US:** “This Agent couldn’t start. Try again. If the problem continues, contact your administrator.”
  - **Generic start failure — zh-CN:** “此 Agent 无法启动。请重试；如果问题仍然存在，请联系管理员。”

## Dimensions with no findings

- **D8 Missing animations/motion:** The assigned paths contain server services, validators, workers, and tests only; they do not render or control panels, lists, loading states, or other UI transitions where an upstream-library animation could be applied.

## Cross-scope notes

- `apps/server/src/enterprise/services/platformPublisher.ts:150-163` similarly swallows invalidation failures before Skill publication returns to the scoped service. Exposing the D6 deferred-refresh state for Skills requires the platform-publisher owner to return delivery status instead of only logging it.
