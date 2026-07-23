# AIHub 二开审计 — 剩余问题清单 (Audit Backlog)

> 由 2026-07-23 的多 agent 审计生成。已修复项见分支 `refactor/enterprise-audit-cleanup` 的 13 个提交；
> 本文件原用于列出**尚未处理**的问题及其**推迟原因**；现保留为结案记录。范围仅限二开 (`src/enterprise/**`, `apps/server/src/enterprise/**`, `packages/*/platform*`, `src/features/Platform*`)。

## 2026-07-23 实施结案

本清单中的可执行代码问题已在 `codex/fix-enterprise-audit-backlog` 分支完成。下文保留原始审计描述，作为修复动机、设计约束和验证范围的历史记录。

- **已修复**: #0, #3, #6, #7, #9, #10, #11, #16, #17, #19, #20, #22, #24, #25, #26, #30, #35, #36, #37, #38, #45, #49, #50, #51, #52, #54, #57, #59, #61, #62, #63, #64, #65, #66, #67, #72, #73, #74, #76, #77, #78, #80, #81, #83, #85, #86, #117。
- **按产品 / 架构决策保留**: #31/#122（本 fork 的真实 Authentik placeholder）、#58（日志与审计 redaction API 有意分离）、#94（测试夹具合同测试提供真实 CAS/rollout 覆盖）。
- **审计复核后无需代码变更**: #87, #88, #89, #90, #91, #93（误报、已移除路径、或需产品决策而明确保留）。
- **迁移记录，不修改已部署文件**: #123, #124, #125, #126, #127, #128；#129 是二开范围外的上游孤儿文件，保持不动。

关键实现说明：

- Provider/connector 批量读取现在使用真正的数据库批量查询，不再把客户端 N+1 隐藏到服务端；provider 跨资源排序仍按独立 revision/CAS 串行提交，避免引入不安全的 multi-CAS 部分失败语义。
- 收敛快照与诊断查询改为常量次数的 CTE/VALUES 聚合，且不在同一事务连接上并发查询。
- 已部署的 `0117–0144` migration 链未被修改。
- 统一验证结果：`bun run check` 通过（183 files，644 tests），`bun run check --type` 通过。

## 为什么这些还没做（分类原因）

- **大型重构 / 单体拆分**：在关键管理员写入流上的高爆炸半径行为改动；部分文件无测试。宜作为逐个评审的独立 PR，非批量清扫。
- **性能 / N+1**：正确修法多需**后端新增批量端点**（如 `get` 接受 `providerKey`）或**运行应用**验证；纯客户端缓存有失效风险。
- **DB 层去重 / 死方法**：本环境缺 `@electric-sql/pglite`，无法运行 DB 行为测试来验证改动 / 删除测试块。
- **迁移**：`0117–0144` 已部署，**禁止修改**；仅记录，须在受控发布中处置。

每项后附：`file:line`・严重度 / 工作量・问题・建议修法・状态。

## Large refactors (long files / long functions / large components)

### \[#24] 849-line file with a single \~745-line mega-component

- **位置**: `src/enterprise/client/features/admin/identityProviders/IdentityProviderWizard.tsx:102`
- **严重度 / 工作量 / 风险**: high · large · needs-human-confirmation
- **问题**: IdentityProviderWizard is one memo component holding \~20 useState/useRef, a 6-branch renderStep() switch (basic/discovery/client/claims/policy/test/publish), plus save/discover/test/publish/rollback orchestration and JSON editors — many mixed responsibilities in one unit, far over the \~400-line file / \~80-line function guidance.
- **建议修法**: Split each wizard step into its own component under a `steps/` folder (BasicStep, DiscoveryStep, ClientStep, ClaimsStep, PolicyStep, TestStep, PublishStep) taking draft+patch props; keep the parent only for step state, dirty tracking, and the save/publish/test actions. This is a pure mechanical extraction but touches a large surface.

### \[#59] upsertMaterialization is a \~160-line method with deep nested branching

- **位置**: `packages/database/src/repositories/platformAgentCatalog/index.ts:1215`
- **严重度 / 工作量 / 风险**: medium · medium · needs-human-confirmation
- **问题**: upsertMaterialization (lines 1215-1374) mixes conflict-insert, idempotency detection, visibility-only upgrade, and CAS update paths in one function, with locally-defined helper predicates (isRealMaterialization/matchesDesiredState) and 4+ levels of conditional nesting. It is the hardest unit in the file to reason about and duplicates state-matching logic already implied elsewhere.
- **建议修法**: Extract the three resolution branches (no-expectedCurrent insert, visibility-only upgrade, expectedCurrent CAS) into private methods, and hoist matchesDesiredState/isRealMaterialization to module scope so they can be unit-tested independently. No SQL change.

### \[#63] Per-domain column projections duplicated across getById/listDomain/rotateExact

- **位置**: `packages/database/src/repositories/platformSecretRotation/index.ts:108`
- **严重度 / 工作量 / 风险**: medium · large · needs-human-confirmation
- **问题**: getById (108-189), listDomain (191-316) and rotateExact (350-459) each contain a 5-6 branch switch that re-declares nearly identical column selections/set-clauses per domain (aiCurrent/aiImmutable/connector/identityProvider/identityProviderTestPkce). The column-to-domain mapping is repeated three times, so adding a domain or column requires editing three switches in lockstep.
- **建议修法**: Introduce a per-domain descriptor table (table ref + column map for select and for CAS predicate) and drive getById/listDomain/rotateExact from it, collapsing the three switches into shared builders.

### \[#19] DependencyEditor is 531 lines with deeply nested render ternaries (>3 levels)

- **位置**: `src/enterprise/client/features/admin/agents/DependencyEditor.tsx:227`
- **严重度 / 工作量 / 风险**: medium · large · needs-human-confirmation
- **问题**: The single component mixes model/skill/connector authoring, six SWR sources, a 'usable' readiness algebra, and a JSX body (lines 227-529) built from nested ternary chains 4-5 deep (e.g. providers.error ? : isLoading ? : empty ? : ( providerId ? source.error ? : isLoading ? : null===data ? : data ? ...)). It is hard to read and exceeds the \~400-line guideline.
- **建议修法**: Split into ModelDependencyField / SkillDependencyField / ConnectorDependencyField subcomponents; replace nested ternaries with a small status-to-node helper per source.

### \[#6] 769-line hook repeats the same guard→writeGuard.begin→openReasonModal→commitAndRefresh→catch scaffold across \~9 handlers

- **位置**: `src/enterprise/client/features/admin/ai/hooks/useAiProviderActions.tsx:168`
- **严重度 / 工作量 / 风险**: medium · large · needs-human-confirmation
- **问题**: openSave, openTest, openPublish, handleSecret, handleArchive, handleRollback, handleCreateModel, handleEditModel, handleDeleteModel, handleReorderModels each repeat: early-return guard, epoch=writeGuard.begin(), snapshot build, openReasonModal with onSubmit that runs commitAndRefresh then catch(handleMutationError)+throw. High structural duplication and a long file.
- **建议修法**: Introduce a runGuardedReasonMutation({guard, snapshot, commit, onCommitted}) helper that encapsulates the epoch+modal+commit+error pattern; each handler supplies only its differences.

### \[#0] SettingsPolicyPage is a 1188-line monolith mixing hydration, CAS/conflict, save/validate/publish/reset and full JSX

- **位置**: `src/enterprise/client/features/admin/settings/SettingsPolicyPage.tsx:183`
- **严重度 / 工作量 / 风险**: medium · large · needs-human-confirmation
- **问题**: One memo component holds \~10 handlers (enterRevisionConflict, refreshConflictServer, handleRebase, handleDiscardConflict, handleSaveDraft, handleValidate, handlePublish, handleResetDefaults) plus a \~300-line render tree and 12+ useState. Far past the project's \~800-line split guideline; hard to reason about state coupling.
- **建议修法**: Extract a useSettingsPolicyEditor hook (state + conflict/CAS handlers) and split the conflict banner and change-preview/group grid into sub-components under features/, leaving the route file thin.

### \[#16] SkillDetailPage.tsx is 731 lines with a single 240-line DetailContent doing everything

- **位置**: `src/enterprise/client/features/admin/skills/SkillDetailPage.tsx:1`
- **严重度 / 工作量 / 风险**: medium · medium · needs-human-confirmation
- **问题**: The file bundles styles, VersionsSection, VersionRow, VersionDetail, DependentsSection and a \~240-line DetailContent (lines 459-700) that owns permissions, editor wiring, action-button matrix, four conflict/persistence banners, and identity rendering. It far exceeds the \~400-line file / \~80-line unit guidance in AGENTS.md.
- **建议修法**: Extract the action-button toolbar and the conflict/persistence banner stack into their own components (e.g. SkillDetailActions, SkillEditorBanners); consider moving VersionsSection/DependentsSection to sibling files.

### \[#57] Oversized contract files exceed the \~800-line split guideline

- **位置**: `apps/server/src/enterprise/contracts/platformConnectors.ts:1`
- **严重度 / 工作量 / 风险**: low · large · needs-verification
- **问题**: contracts/platformConnectors.ts is 1468 lines (89 exports), adminAudit.ts is 888 lines (102 exports), and platformAgents.ts is 836 lines (130 exports) — all well past the \~800-line guideline in AGENTS.md, making them hard for humans and agents to navigate. These are pure schema/type contract files that split cleanly along sub-domains.
- **建议修法**: Split each into focused sub-modules (e.g. platformConnectors → draft/publication/governance/runtime schema groups) re-exported from an index, preserving all exported symbol names.

### \[#80] skillCatalog.ts mixes several responsibilities in one 577-line module

- **位置**: `packages/database/src/models/platform/skillCatalog.ts:1`
- **严重度 / 工作量 / 风险**: low · medium · needs-verification
- **问题**: The file bundles pure canonicalization helpers (canonicalizePlatformSkill\*), checksum/token functions, the snapshot parser/validator, the PlatformSkillCatalogModel aggregate, and the createPlatformSkillPointerAdapter factory. It exceeds the \~400-line guideline and couples unrelated concerns, making the model harder to navigate/test in isolation.
- **建议修法**: Split into cohesive units: e.g. skillCanonicalize.ts (canonicalize + checksum + snapshot parse), skillCatalog.model.ts (the class), and skillCatalog.pointer.ts (the adapter). Keep re-exports through index.ts.

### \[#49] 586-line adapter holds two large service classes and module-level mutable state

- **位置**: `src/enterprise/client/services/adminAiInfraAdapter/index.ts:36`
- **严重度 / 工作量 / 风险**: low · medium · needs-verification
- **问题**: AdminAiProviderService and AdminAiModelService plus the module-level lastPublishOutcome singleton (lines 44-61) all live in one 586-line file. The two classes are independent and the mutable publish-outcome state is a hidden global coupling that only DraftPublishBanner reads.
- **建议修法**: Split AdminAiModelService into its own module and consider moving publish-outcome tracking into the store instead of a module-level let; keep the barrel adminAiInfraServices export.

## Performance / N+1 (mostly needs a backend change or a running-app to verify)

### \[#36] getAiProviderRuntimeState issues one get.query per provider (N+1)

- **位置**: `src/enterprise/client/services/adminAiInfraAdapter/index.ts:329`
- **严重度 / 工作量 / 风险**: high · medium · needs-human-confirmation
- **问题**: After paginating the whole provider list, it fires lambdaClient.admin.aiProviders.get.query for EVERY active provider via Promise.all (lines 340-349) just to collect draft.models. This adapter powers the admin AI settings store's getAiProviderRuntimeState action (store/aiInfra/slices/aiProvider/action.ts:600), so opening/refreshing the admin AI runtime state does 1 + N round trips.
- **建议修法**: Add/extend a server contract that returns providers with their draft models in one (paginated) call, or a bulk get-by-ids, and build runtime state from that instead of per-provider get.query. If not feasible now, at least cap concurrency and short-circuit providers already known disabled.

### \[#37] Every admin AI write re-paginates full provider list to resolve a UUID

- **位置**: `src/enterprise/client/services/adminAiInfraAdapter/index.ts:64`
- **严重度 / 工作量 / 风险**: high · medium · needs-human-confirmation
- **问题**: resolveProviderRecord (line 64) loops up to 20 pages x 100 rows to map providerKey->UUID; getDetail (line 81) calls it on nearly every mutation, and getOrCreateDetail wraps getDetail again. Each toggle/update/create/delete pays a full list scan before the actual mutation.
- **建议修法**: Expose a server get-by-providerKey lookup (or cache the providerKey->id map within the service instance for the page session) so getDetail resolves in one query instead of scanning all pages.

### \[#38] updateAiProviderOrder does a full-list-scan getOrCreateDetail per item, sequentially

- **位置**: `src/enterprise/client/services/adminAiInfraAdapter/index.ts:286`
- **严重度 / 工作量 / 风险**: high · medium · needs-verification
- **问题**: The for-loop (lines 287-301) calls getOrCreateDetail(item.id) for each reordered provider, and each of those triggers resolveProviderRecord's up-to-20-page scan plus an applyImmediate mutate — all awaited serially. Reordering M providers => O(M) full list scans + M sequential publishes.
- **建议修法**: Resolve all provider records once (single list pass), then issue the sort applyImmediate mutations from the cached details; consider a batch reorder contract like batchUpdateAiModels already uses.

### \[#74] replacePublishedPolicies issues one upsert round-trip per draft path

- **位置**: `packages/database/src/models/platform/settings.ts:135`
- **严重度 / 工作量 / 风险**: medium · small · needs-verification
- **问题**: The `for (const path of paths)` loop (lines 135-164) performs a separate INSERT ... ON CONFLICT DO UPDATE per setting path inside the publish transaction. For a bundle with many paths this is N sequential DB round-trips holding the publish lock, scaling linearly with draft size.
- **建议修法**: Build the values array and issue a single `insert(...).values(rows).onConflictDoUpdate(...)` (multi-row upsert), or chunk into batched inserts, instead of awaiting one statement per path.

### \[#61] reorderModels issues one UPDATE per model in a loop (N+1 writes)

- **位置**: `packages/database/src/repositories/platformAiCatalog/index.ts:440`
- **严重度 / 工作量 / 风险**: medium · small · needs-verification
- **问题**: After selecting owned ids, reorderModels loops over items and awaits a separate UPDATE for each model (lines 440-446). A reorder of K models is K sequential round-trips instead of one statement.
- **建议修法**: Replace the loop with a single UPDATE using a CASE/VALUES join keyed on id (scoped to providerId and the owned id set), e.g. update ... set sort = CASE id ... END, status='draft' where providerId=? and id in (...). Preserves the owner-scoped guard and draft demotion.

### \[#62] Convergence snapshot runs one aggregate query per target domain

- **位置**: `packages/database/src/repositories/platformInstance/index.ts:264`
- **严重度 / 工作量 / 风险**: medium · medium · needs-verification
- **问题**: getConvergenceInventorySnapshot loops over targets and issues a separate leftJoin+aggregate query per target (lines 264-313); listDiagnosticCandidates likewise issues one issue-query per target inside a loop (lines 182-213). Query count scales linearly with the number of domains on every snapshot read.
- **建议修法**: Aggregate across domains in a single grouped query (GROUP BY domain with FILTER expressions), or at minimum run the per-target aggregates via Promise.all instead of sequential awaits. Bounded by domain count today, but keeps snapshot cost constant as domains grow.

### \[#7] Per-connector detail fetch fans out one request per connector (up to 50) to build tool scope

- **位置**: `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:151`
- **严重度 / 工作量 / 风险**: medium · medium · needs-human-confirmation
- **问题**: connectorDetailsSWR does Promise.all over connectorListItems.slice(0,50) calling adminConnectorsService.get({id}) for each — a classic N+1 against the list. Every connector view load issues up to 50 individual RPCs to assemble tools/CAS tokens.
- **建议修法**: Add a batched admin endpoint (get details for many ids / include tools in list) or lazy-load a connector's detail only when its row expands.

### \[#78] replaceDraft does a per-resource SELECT then UPDATE in a sequential loop

- **位置**: `packages/database/src/models/platform/managedResourcePolicy.ts:133`
- **严重度 / 工作量 / 风险**: low · small · needs-verification
- **问题**: replaceDraft (133-152) runs one SELECT followed by one UPDATE for each of the five managed resources sequentially inside the transaction; materializePublished (171-185) similarly issues five sequential UPDATEs. Bounded to five fixed rows so impact is small, but it is 10 serial round-trips where a single read + batched write would do.
- **建议修法**: Read all five config rows in one SELECT (already available via listRows), compute the new configs in memory, and apply updates (e.g. via a single CASE-based UPDATE or batched statements) rather than looping select+update per resource.

## Duplication & structure (dedup opportunities)

### \[#25] Reauth/abort/snapshot submit orchestration duplicated with openReasonModal

- **位置**: `src/enterprise/client/features/admin/users/modals/CreateUserModal.tsx:263`
- **严重度 / 工作量 / 风险**: high · medium · needs-human-confirmation
- **问题**: CreateUserModalContent.handleSubmit (263-336) and ReasonModalContent.handleSubmit in openReasonModal.tsx (154-234) are near-identical: same setPhaseBoth ref pattern, mountedRef/abortRef lifecycle, createCanonicalSnapshot + cloneFromCanonical per attempt, withAdminReauthRetry wiring, and the same catch mapping of AdminReauthCancelledError/AdminReauthBlockedError plus the identical finally block. Two copies drift independently.
- **建议修法**: Extract a shared `useReauthMutation`/`runReauthedSubmit` hook (phases, abort ref, canonical clone, error-key mapping) and have both modals consume it; keep only their form/credentials specifics.

### \[#50] assert\*DangerousReauth reauth-denied-audit helper duplicated across \~14 router files

- **位置**: `apps/server/src/enterprise/routers/admin/branding.ts:140`
- **严重度 / 工作量 / 风险**: medium · medium · needs-human-confirmation
- **问题**: Nearly identical helpers exist in branding.ts:140, aiCatalogSupport.ts:107, credsSupport.ts:70 (all three literally named `assertDangerousReauth`), plus connectorsGovernance.ts:69, connectorsSupport.ts:388, skillsSupport.ts:84, agentsSupport.ts:90, audit.ts:103, identityProviders.ts:145, settings.ts:68, managedResources.ts:42, security.ts:73, system.ts:138/172. Each: call assertRecentReauth, on failure write a best-effort 'denied' PlatformAuditService.append, catch/console.error, rethrow — differing only in targetType/targetId strings. This is \~14 copies of the same audit-on-denial logic that must be kept in sync (e.g. if the denied-audit shape or swallow policy changes).
- **建议修法**: Extract a shared helper (e.g. guards/reauth `assertDangerousReauthWithAudit({ action, actorUserId, authenticatedAt, authMethod, reason, serverDB, targetType, targetId, requestId? })`) and have each router call it with its target descriptor. Preserve each site's existing targetType/targetId and the best-effort swallow semantics.

### \[#52] RFC 6052 IPv4-embedding layout table defined twice in parallel forms

- **位置**: `apps/server/src/enterprise/security/outboundHttp/policy.ts:156`
- **严重度 / 工作量 / 风险**: medium · medium · needs-verification
- **问题**: `extractRfc6052Ipv4Candidates` (lines 135-154) encodes the six RFC 6052 layouts as an array with `requiresZeroUOctet`, used by `isMetadataIp` (line 193). `RFC6052_LAYOUTS` (lines 156-163) encodes the same layouts as a Map keyed by prefix length, used by `extractRfc6052Ipv4`/`isPubliclyRoutableIp` (line 319). Both are SSRF-defense-critical decoders of the same standard; a correction to one layout set would not propagate to the other.
- **建议修法**: Derive both call paths from a single source of truth for the RFC 6052 index layouts (one keyed table), so the candidate-scan and prefix-anchored decode share identical index definitions.

### \[#51] streamFetch duplicates fetch's redirect/DNS-pin loop and uses inline magic-number redirect arrays

- **位置**: `apps/server/src/enterprise/security/outboundHttp/safeOutboundHttpClient.ts:182`
- **严重度 / 工作量 / 风险**: medium · medium · needs-verification
- **问题**: `streamFetch` (lines 166-225) re-implements the same policy-check → resolveHost → assertResolvedAddresses → transport → redirect loop as `fetch` (lines 75-163). It also hardcodes redirect status literals `[301, 302, 303, 307, 308]` (line 197) and `[301, 302, 303]` (line 220) instead of reusing the module's `REDIRECT_STATUSES` set (line 31) and the 303/302/301 handling used by `fetch`. Two divergent copies of security-sensitive redirect logic risk drift (a rule fixed in one path silently missing from the other).
- **建议修法**: Reuse the shared `REDIRECT_STATUSES` constant in streamFetch, and factor the common redirect/pin/validate step into a private helper shared by both fetch and streamFetch. Keep streaming-specific body-cancel handling in streamFetch.

### \[#72] Sensitive-key set and secret regexes duplicated from redact.ts (drift risk)

- **位置**: `packages/database/src/models/platform/auditCredentialMask.ts:54`
- **严重度 / 工作量 / 风险**: medium · medium · needs-human-confirmation
- **问题**: CREDENTIAL\_KEY\_EXACT (lines 54-88) is a near-verbatim copy of SENSITIVE\_KEY\_EXACT in redact.ts (lines 16-50), and the secret-shape regexes (PREFIXED\_SECRET, JWT, AWS\_ACCESS\_KEY, GCP\_API\_KEY, PEM\_PRIVATE\_KEY) at lines 17-24 duplicate the identical patterns in redact.ts lines 82-83/216-219. The read-path masker and the write-path redactor now maintain two independent copies of the same security-critical constants; adding a new credential form to one silently leaves the other blind.
- **建议修法**: Extract the shared exact-key list and the shared secret-shape regexes into one module (e.g. a `secretPatterns.ts`) and import them into both redact.ts and auditCredentialMask.ts. Keep only the intentionally-stricter suffix/exact matching logic local to auditCredentialMask.

### \[#76] Audit policy defaults duplicate the schema column defaults (magic numbers in two places)

- **位置**: `packages/database/src/models/platform/auditPolicy.ts:33`
- **严重度 / 工作量 / 风险**: medium · small · needs-verification
- **问题**: DEFAULT\_POLICY\_VALUES (33-43) hard-codes conversationRetentionDays 180 / exportArtifactRetentionDays 7 / operationLogRetentionDays 365 / maxExportRows 50\_000 / maxListWindowDays 90, which restate the pgTable column .default() values in auditAdmin.ts (lines 129-142). The comment even says 'Defaults must match column defaults' — a manual invariant with no enforcement, so the two can drift.
- **建议修法**: Define the numeric defaults once in a shared const and reference it from both the schema column .default(...) and DEFAULT\_POLICY\_VALUES; or drop the explicit insert values and let the DB column defaults populate on getOrCreate.

### \[#73] Cursor/pagination helpers copy-pasted across \~5 audit models

- **位置**: `packages/database/src/models/platform/auditRetentionRun.ts:60`
- **严重度 / 工作量 / 风险**: medium · small · needs-verification
- **问题**: clampListLimit (min/max 1..200), encodeCursor (`${createdAt.toISOString()}|${id}`) and parseCursor are duplicated almost verbatim in auditRetentionRun.ts (60-72), auditExport.ts (60-72), auditLegalHold.ts (51-63) and auditConversation.ts (18-30), with a renamed variant in auditRetention.ts (73-86) and auditLog.ts (84-104). Six hand-maintained copies of the same keyset-cursor contract.
- **建议修法**: Move the shared clamp/encode/parse composite-cursor helpers into one internal util (e.g. models/platform/cursor.ts) and import them; keep any dimension-specific variant (audit log's Date-legacy parser) as a thin wrapper.

### \[#81] 12 enum types hand-written as literal unions instead of deriving from their const arrays

- **位置**: `packages/observability-otel/src/modules/enterprise-platform/attributes.ts:96`
- **严重度 / 工作量 / 风险**: medium · small · needs-verification
- **问题**: Sibling types derive from the source-of-truth arrays via `(typeof X)[number]` (e.g. EnterpriseConfigDomain line 99, EnterpriseGuardResource line 105), but 12 types are hand-written literal unions that duplicate the array members: EnterpriseCacheEpochOutcome/LoadOutcome/RequestOutcome (96-98), EnterpriseConfigPublishOperation/Outcome (100-101), EnterpriseGuardClassification/Mode/Outcome (102-104), EnterpriseHeartbeatOperation/Outcome (106-107), EnterpriseInvalidationBackend/Outcome (108-110). Each duplicates the matching `ENTERPRISE_*` array (e.g. ENTERPRISE\_CACHE\_EPOCH\_OUTCOMES line 79). Adding a value to an array without updating its twin union silently drifts the compile-time type from the runtime allowlist used by closedValue().
- **建议修法**: Change each of the 12 unions to `export type X = (typeof ENTERPRISE_X)[number];` so the type is generated from the single const-array source, matching the already-correct siblings.

### \[#30] Cursor-pagination + polling boilerplate duplicated across audit pages

- **位置**: `src/enterprise/client/features/admin/audit/exports/ExportsPage.tsx:81`
- **严重度 / 工作量 / 风险**: medium · medium · needs-human-confirmation
- **问题**: ExportsPage, RetentionPage and OperationLogsPage each re-implement the same cursorStack/limit state, onNext/onPrevious/onPageSizeChange handlers, and a `refreshInterval: latest => latest?.items?.some(pending|running) ? POLL_MS : 0` poller. POLL\_MS = 4000 is copy-defined in ExportsPage, RetentionPage and LivePage.
- **建议修法**: Extract a `useCursorPagination` hook and a shared `pollWhileInFlight` helper (and hoist POLL\_MS into a shared const) reused by the audit list pages.

### \[#17] VersionsSection and DependentsSection duplicate the cursor-stack pagination + error scaffolding

- **位置**: `src/enterprise/client/features/admin/skills/SkillDetailPage.tsx:168`
- **严重度 / 工作量 / 风险**: medium · medium · needs-human-confirmation
- **问题**: Both memo components independently reimplement the same cursorStack state, prev/next pager (styles.pager), the 'error && !data' vs 'error && data' Alert-with-retry split, the isLoading SkeletonList, and the Empty branch (lines 135-214 vs 365-455). Only the row rendering and i18n keys differ.
- **建议修法**: Extract a shared paginated-list wrapper (or hook) that takes the SWR result, an itemRenderer, and i18n key prefix; both sections delegate to it.

### \[#26] Outer closure variables mutated during render inside memo components

- **位置**: `src/enterprise/client/features/admin/users/modals/actions.tsx:147`
- **严重度 / 工作量 / 风险**: medium · medium · needs-human-confirmation
- **问题**: ControlledBan (144-162), ControlledRevoke (253-258) and ControlledRoles (380-407) assign to the enclosing `mode`/`expiresAt`/`selected`/`includeCurrent` variables during render so buildPayload/validateExtra can read them. Writing to captured outer state during render is a fragile anti-pattern (breaks under concurrent/double render) repeated three times.
- **建议修法**: Have the modal own the state via a ref updated in an onChange callback (or pass buildPayload the live values through openReasonModal's extra API) instead of mutating closure vars in render.

### \[#54] @deprecated SharedAdminMutationRateLimiter is the actual production class

- **位置**: `apps/server/src/enterprise/security/rateLimit/adminMutationRateLimiter.ts:147`
- **严重度 / 工作量 / 风险**: low · small · needs-verification
- **问题**: `SharedAdminMutationRateLimiter` is marked `@deprecated Alias kept for callers`, yet it is the class instantiated by the production singleton `getSharedAdminMutationRateLimiter` (line 192), which is the sole consumer (guards/adminMutationRateLimit.ts:89). No external caller uses the deprecated name. The @deprecated tag is misleading — the 'deprecated' alias is the live production path.
- **建议修法**: Either instantiate PostgresAdminMutationRateLimiter directly in getSharedAdminMutationRateLimiter and remove the alias, or drop the @deprecated tag since it is the intended production class.

### \[#58] redactForLog and redactForAudit are identical pass-through wrappers

- **位置**: `apps/server/src/enterprise/security/redaction/redact.ts:71`
- **严重度 / 工作量 / 风险**: low · trivial · needs-human-confirmation — **KEEP — redactForLog/redactForAudit are documented as intentionally separate for possible future divergence.**
- **问题**: Both `redactForLog` (line 71) and `redactForAudit` (line 78) have byte-identical bodies `redactDeep(input, options)`. The comments justify the split as future-proofing for divergent pipelines, but today they are two names for one function — a speculative abstraction with no behavioral difference.
- **建议修法**: Acceptable to keep given the documented intent; if divergence never materializes, collapse to a single exported function (or keep one as an alias) to avoid the illusion of differing behavior.

### \[#67] isRootDatabase/inTransaction helpers duplicated verbatim across two repositories

- **位置**: `packages/database/src/repositories/platformAgentCatalog/index.ts:124`
- **严重度 / 工作量 / 风险**: low · small · needs-verification
- **问题**: The identical isRootDatabase + inTransaction helper pair is defined in both platformAgentCatalog/index.ts (124-130) and platformConnectorCatalog/index.ts (65-71). Copy-pasted transaction plumbing drifts independently.
- **建议修法**: Extract to a shared module (e.g. repositories/platform/tx.ts or an existing db util) and import in both files.

### \[#85] Six ObservableGauge callbacks repeat the same active-collector / snapshot-guard / observe-loop scaffolding

- **位置**: `packages/observability-otel/src/modules/enterprise-platform/index.ts:219`
- **严重度 / 工作量 / 风险**: low · small · needs-verification
- **问题**: jobBacklogGauge (219), jobBacklogOldestAgeGauge (228), revisionLagInstancesGauge (237), revisionFreshInstancesGauge (249), operationalSnapshotReadyGauge (256), operationalSnapshotAgeGauge (263) each re-implement near-identical structure: check activeOperationalCollectors membership, bail on null snapshot, iterate entries, build attributes, skip on missing attribute key, observe. The two job\_backlog callbacks differ only in `entry.count` vs `entry.oldestAgeSeconds`.
- **建议修法**: Extract a small helper (e.g. observeJobBacklog(result, valueSelector) and observeCollectorPresence) to collapse the duplicated guard+loop; keep the distinct value selectors as callbacks.

### \[#83] Deep cross-package relative imports instead of the @/const alias used elsewhere in the same folder

- **位置**: `packages/types/src/platform/errors.ts:5`
- **严重度 / 工作量 / 风险**: low · trivial · needs-verification
- **问题**: errors.ts (lines 5,12) and featureFlags.ts (line 8) reach into another package's source with `../../../const/src/platform/...`, while managedResources.ts in the same directory imports the same package via the alias `@/const/platform/managedResources` (line 4). The fragile relative path breaks if the file moves and is inconsistent with the established convention.
- **建议修法**: Replace `../../../const/src/platform/errorCodes` and `../../../const/src/platform/featureFlags` with `@/const/platform/errorCodes` / `@/const/platform/featureFlags` to match managedResources.ts.

### \[#22] Three admin localDraftStorage modules use divergent secret/size strategies

- **位置**: `src/enterprise/client/features/admin/agents/localDraftStorage.ts:20`
- **严重度 / 工作量 / 风险**: low · medium · needs-human-confirmation
- **问题**: agents/localDraftStorage.ts hand-rolls SENSITIVE\_KEY\_PATTERN + SECRET\_VALUE\_PATTERNS + MAX\_SCAN\_NODES; skills/localDraftStorage.ts delegates to server containsEnterpriseSecretMaterial with size caps; connectors/localDraftStorage.ts has neither (only a field whitelist). The inconsistent rigor is a maintenance hazard — a secret-bearing connector field would persist where an agent one would not.
- **建议修法**: Extract a shared client draft-storage helper (secret scan + size cap + fail-closed persist) and have all three feature stores use it; the agents comment says it intentionally avoids the server chain, so standardize on one client-side approach.

### \[#10] ProviderDetailContent renders 5 unrelated sections inline (\~320 lines)

- **位置**: `src/enterprise/client/features/admin/ai/providers/ProviderDetailPage.tsx:95`
- **严重度 / 工作量 / 风险**: low · medium · needs-human-confirmation
- **问题**: One component composes conflict banners, editor fields, models section, secret panel, connection-test panel and paginated revisions list with its own rebase/cursor state, making the JSX tree long and mixed-responsibility.
- **建议修法**: Split the secret panel, connection-test panel and revisions list into small presentational sub-components; keep detail as an orchestrator.

### \[#20] changeConnectorCredentialMode's secret param and secret return value are both dead

- **位置**: `src/enterprise/client/features/admin/connectors/controller.ts:75`
- **严重度 / 工作量 / 风险**: low · small · needs-verification
- **问题**: changeConnectorCredentialMode takes a third arg `_secret` (unused) and returns { draft, secret }, but the only caller (useConnectorEditor.ts:108) passes `secret` needlessly, reads only `.draft`, and separately calls setSecret(createEmptyConnectorSecretEdit()). The secret half of the abstraction adds nothing.
- **建议修法**: Drop the `_secret` parameter and the `secret` return field; have the helper return just the next draft.

### \[#31] Customer-specific domain hardcoded as issuer placeholder

- **位置**: `src/enterprise/client/features/admin/identityProviders/controller.ts:123`
- **严重度 / 工作量 / 风险**: low · trivial · needs-human-confirmation — **KEEP — auth.jiefakj.com is this fork’s real Authentik domain; a helpful discovery-step placeholder, not a leak.**
- **问题**: `AUTHENTIK_ISSUER_PLACEHOLDER = 'https://auth.jiefakj.com/application/o/<slug>/'` bakes a single tenant's hostname into a UI placeholder shared by all deployments of this fork.
- **建议修法**: Use a neutral example host (e.g. auth.example.com) or derive from platform app-URL config.

### \[#3] Native window\.confirm used for unsaved-leave prompt, inconsistent with base-ui confirmModal

- **位置**: `src/enterprise/client/features/admin/settings/SettingsPolicyPage.tsx:246`
- **严重度 / 工作量 / 风险**: low · small · needs-human-confirmation
- **问题**: The blocker handler calls window\.confirm(t('settingsPolicy.unsavedLeave')) — a blocking native dialog — while BrandingPage.tsx uses confirmModal for the same flow. Violates the base-ui-first convention and gives an unstyled prompt.
- **建议修法**: Replace with confirmModal (base-ui), mirroring BrandingPage's leave-modal handling.

### \[#9] beforeunload + router-blocker unsaved-guard reimplemented in every admin editor (9 copies)

- **位置**: `src/enterprise/client/features/admin/settings/SettingsPolicyPage.tsx:325`
- **严重度 / 工作量 / 风险**: low · medium · needs-human-confirmation
- **问题**: The dirty→beforeunload listener plus useBlocker leave-modal logic is duplicated in SettingsPolicyPage.tsx:325, BrandingPage.tsx:200/162, useAiProviderEditor.ts:82/92 and 6 other admin editors (grep beforeunload finds 9). identityProviders even has a bespoke useUnsavedIdentityProviderGuard instead of a shared one.
- **建议修法**: Extract one useUnsavedChangesGuard(dirty, {message}) hook and adopt it across the admin editors.

### \[#35] Redundant equivalent clear-detection conditions

- **位置**: `src/enterprise/client/features/admin/users/UsersListPage.tsx:225`
- **严重度 / 工作量 / 风险**: low · trivial · needs-verification
- **问题**: handleFilterBarChange guards with `!hasActiveAdminFiltersHelper(next) || isClearPayload(next)`, but hasActiveAdminFiltersHelper returns true iff some field is non-empty and isClearPayload returns true iff every field is empty — so `!hasActive` and `isClearPayload` are the same predicate and the `||` branch is redundant.
- **建议修法**: Drop one of the two checks (keep `!hasActiveAdminFiltersHelper(next)`), and remove the unused isClearPayload helper if it has no other callers.

### \[#45] Autofill effect reads agentName/agentDescription/selectedPlatformDef but omits them from deps

- **位置**: `src/features/CreatePlatformAgent/index.tsx:164`
- **严重度 / 工作量 / 风险**: low · small · needs-human-confirmation
- **问题**: The step-2 autofill useEffect (lines 164-172) references agentName, agentDescription and selectedPlatformDef.name in its body but declares deps \[step, agentProfile, fetchingProfile]. This is a stale-closure/exhaustive-deps smell; correctness currently relies on the effect only needing to fire on step/profile transitions.
- **建议修法**: Guard the intent explicitly (e.g. a ran-once ref or reading latest values via refs) or add the missing deps with the intended guard so the omission is deliberate and lint-clean.

## Error-handling & robustness

### \[#86] platformName interpolated unsanitized while warnings are explicitly sanitized

- **位置**: `packages/prompts/src/prompts/botPlatformContext/index.ts:21`
- **严重度 / 工作量 / 风险**: low · trivial · needs-human-confirmation
- **问题**: warnings are HTML/XML-escaped (sanitize, lines 58-62) precisely to prevent prompt injection, but platformName is interpolated raw into an XML-ish attribute `platform="${platformName}"` (line 21) and markdown `**${platformName}**` (line 22). Today platformName is a trusted platform constant (platformDef.name), so risk is low, but the inconsistency is a latent injection/tag-break vector if the source ever becomes config- or user-derived. The sanitize fn is also re-created on every call.
- **建议修法**: Apply the same escaping to platformName (at least escape `<>&"`), and hoist sanitize to module scope so it isn't rebuilt per invocation.

### \[#11] Per-connector detail errors are silently swallowed, hiding partial-load failures

- **位置**: `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:158`
- **严重度 / 工作量 / 风险**: low · small · needs-human-confirmation
- **问题**: In connectorDetailsSWR the map catches with `catch { return null }` and filters nulls, so a connector whose detail fails to load just disappears from the governance/tool matrix with no surfaced error — an admin editing permissions may not realize a connector is missing.
- **建议修法**: Track failed ids and surface a non-fatal banner (e.g. 'N connectors failed to load, retry') instead of dropping them silently.

## Dead code (deferred — DB methods need pglite; type-only aliases low priority)

### \[#77] Unreachable reason value and permanently-constant response fields after Authentik-only migration

- **位置**: `packages/database/src/models/platform/accessStatus.ts:19`
- **严重度 / 工作量 / 风险**: low · trivial · needs-human-confirmation
- **问题**: resolvePlatformAccessStatus now always returns accessGranted:true with degraded:false, grantVersion:null, permissionRequestUrl:null; the 'not\_granted' member of the reason union (line 19) is never produced, and the three constant fields are vestigial from the removed allowlist-gating design (comment: 'Always null; kept for response shape compatibility').
- **建议修法**: If the response contract can change, drop 'not\_granted' from the union and the always-null fields; otherwise leave a single explanatory comment and remove the dead 'not\_granted' branch expectation. Confirm no consumer switches on reason==='not\_granted' first.

### \[#66] listLatestPublishedProviderRevisions has no callers

- **位置**: `packages/database/src/repositories/platformAiCatalog/index.ts:238`
- **严重度 / 工作量 / 风险**: low · trivial · needs-verification
- **问题**: listLatestPublishedProviderRevisions (238-280) builds a non-trivial subquery join but has zero references anywhere in packages/apps/src and is not even exercised by name outside platformAiCatalog/index.test.ts.
- **建议修法**: Grep-confirm it is genuinely unused (including dynamic access), then delete it, or wire up the intended caller if this was a not-yet-integrated feature.
- **对抗复核**: 确认可删 — Genuinely dead. The only production reference to listLatestPublishedProviderRevisions (plural) is its own definition at packages/database/src/repositories/platformAiCatalog/index.ts:238. All productio

### \[#64] consumeOAuthState wrapper has no production callers

- **位置**: `packages/database/src/repositories/platformConnectorCatalog/index.ts:738`
- **严重度 / 工作量 / 风险**: low · trivial · needs-verification
- **问题**: consumeOAuthState (738-743) is a thin wrapper over reserveOAuthState that only returns the reserved state. Grep across packages/apps/src shows no non-test call site (only platformConnectorCatalog/index.test.ts references it); callers use reserveOAuthState directly.
- **建议修法**: Confirm no external/service usage, then delete the wrapper (and its test) or inline it where needed.
- **对抗复核**: 确认可删 — The catalog method consumeOAuthState at platformConnectorCatalog/index.ts:738 is a thin wrapper over reserveOAuthState. Its only references are in the sibling test file (index.test.ts). Production cal

### \[#65] revokeBinding wrapper unused; callers use revokeBindingWithPreviousSecret

- **位置**: `packages/database/src/repositories/platformConnectorCatalog/index.ts:1275`
- **严重度 / 工作量 / 风险**: low · trivial · needs-verification
- **问题**: revokeBinding (1275-1279) just calls revokeBindingWithPreviousSecret and drops the secret refs. The only production caller (userOAuthService.ts:470) uses revokeBindingWithPreviousSecret directly; revokeBinding has no non-test call site (only referenced in index.test.ts).
- **建议修法**: Verify no other consumer, then remove the leaky wrapper (and its test), or keep only if it is a documented public API.
- **对抗复核**: 确认可删 — revokeBinding (singular wrapper, index.ts:1275-1279) has zero non-test production callers. Its only references outside its own definition are in index.test.ts (826, 857, 866, 1210). The sole productio

### \[#117] \~58 unused exported type aliases (Drizzle insert/select + contract/type shapes)

- **位置**: `packages/database/src/schemas/platform/branding.ts:126`
- **严重度 / 工作量 / 风险**: low · medium · needs-verification
- **问题**: Large cluster of exported TS type aliases with repo-wide word-count = 1 (declaration only), no non-test references and no barrel consumer. Breakdown: 33 Drizzle $inferInsert/$inferSelect aliases under packages/database/src/schemas/platform/\*\* (e.g. NewPlatformBranding branding.ts:126, NewPlatformBrandingAsset :194, NewPlatformConnectorSecret connectors.ts:282, NewPlatformIdentityProviderInstance identity.ts:382, NewPlatformSettingsBundle settings.ts:52, NewPlatformSidebarLayout sidebarLayout.ts:24, PlatformAuthSettingsItem authSettings.ts:22, etc.); 15 contract type aliases under apps/server/src/enterprise/contracts/\*\* (e.g. AdminUserGlobalRole adminUsers.ts:157, AiModelDraft aiCatalog.ts:605, AdminPlatformAgentDetailOutput platformAgents.ts:748, PlatformConvergenceSource platformInstanceStatus.ts:451, SkillIdentityDraft skillCatalog.ts:583); 10 interfaces/types under packages/types/src/platform/\*\* (e.g. PlatformAgentAssignment agents.ts:136, SettingsPolicyBundle settings.ts:107, PlatformPublicLoginSnapshot publicSnapshot.ts:61). Full list in scratchpad dead2.txt. These are type-only so zero runtime risk; many are convention-generated `New*` inserts that may be kept intentionally — lower priority than the runtime dead code above.
- **建议修法**: Prune the unused type aliases (start with the contract Output/Draft types, which usually indicate a removed procedure; keep or delete the New\* Drizzle aliases per your schema convention).
- **对抗复核**: 确认可删 — Sampled \~28 of the \~58 claimed symbols with repo-wide word-boundary grep (packages, apps/server, src, all .ts/.tsx incl. tests). Each appears exactly once — at its own declaration — with no other refe

### \[#122] Customer-specific domain hardcoded as a generic IdP wizard placeholder

- **位置**: `src/enterprise/client/features/admin/identityProviders/controller.ts:123`
- **严重度 / 工作量 / 风险**: low · trivial · needs-human-confirmation — **KEEP — same as #31; fork-intentional placeholder.**
- **问题**: `AUTHENTIK_ISSUER_PLACEHOLDER = 'https://auth.jiefakj.com/application/o/<slug>/'` bakes the specific customer domain `auth.jiefakj.com` into the generic Authentik issuer input placeholder shown in the IdP wizard UI. In a reusable enterprise/admin surface this leaks a single tenant's hostname into shared code and would render a wrong example for any other deployment.
- **建议修法**: Replace with a neutral example host such as `https://auth.example.com/application/o/<slug>/` (or derive from the current instance/branding domain if available). Verify this is not a fork-intentional constant before changing.

## Test rot

### \[#87] Env-gated PG suites that never execute in any CI path

- **位置**: `apps/server/src/enterprise/services/agentCatalog/adminService.pg.test.ts:48`
- **严重度 / 工作量 / 风险**: high · small · needs-verification
- **问题**: These four files gate their entire suite behind `const run = enabled ? describe : describe.skip` where `enabled = process.env.TEST_SERVER_DB === '1' && DATABASE_TEST_URL`. The main workflow (.github/workflows/test.yml) sets DATABASE\_TEST\_URL but NOT TEST\_SERVER\_DB, so `enabled` is false there. The only workflow that sets TEST\_SERVER\_DB=1 is enterprise-failure-drills.yml, which runs an EXPLICIT hand-listed set of pg files — and these four are not in that list. Net: adminService.pg.test.ts, agentCatalog/dependencyLock.pg.test.ts, agentCatalog/effectiveResolver.pg.test.ts, and packages/database/src/models/**tests**/platform.job.recovery.multiconn.pg.test.ts are describe.skip in every CI path and locally. They assert real-Postgres constraints/triggers/advisory-lock behavior (the whole reason they exist) yet never run — dormant tests giving false confidence.
- **建议修法**: repair — add these four files to the enterprise-failure-drills.yml run\_suite list (or delete them if the invariants are covered elsewhere). Verify against both workflows before choosing.
- **对抗复核**: 驳回 / 保留 — REFUTED. The claim asserts all four files are describe.skip in every CI path, but packages/database/src/models/**tests**/platform.job.recovery.multiconn.pg.test.ts actually EXECUTES against real Postg

### \[#90] Round-based test accretion overlaps users.adversarial / users.r2

- **位置**: `apps/server/src/enterprise/routers/admin/users.rework.test.ts:103`
- **严重度 / 工作量 / 风险**: medium · medium · needs-verification
- **问题**: admin.users has five parallel router test files that grew by iteration round: users.rework (describe blocks titled 'M04 R1 — ...'), users.r2 ('R2-01..R2-04'), and users.adversarial (comprehensive). Coverage overlaps heavily: the role permission matrix is in both users.rework ('M04 R1 — identity\_admin matrix', line 261) and users.adversarial ('admin.users permission matrix', line 170, a superset also covering user\_admin/ai\_admin/auditor/super\_admin); reauth-staleness denial appears in users.rework (229), users.adversarial (292), and again per-procedure in users.create/users.delete. The R1/R2 naming is process scaffolding, not durable behavior grouping, and makes the real coverage hard to reason about.
- **建议修法**: repair/dedupe — fold users.rework and users.r2's still-unique cases into users.adversarial and drop the round-labeled files and the identity\_admin-matrix subset already covered by the adversarial matrix. Diff each case before deleting.
- **对抗复核**: 驳回 / 保留 — Refuted. The three round-based test files are not self-contained and are referenced by security-acceptance infrastructure. penManifest.ts:82 registers users.adversarial.test.ts as a required test file

### \[#93] Concurrency negative-assertions rely on arbitrary real sleeps

- **位置**: `apps/server/src/enterprise/services/identityProvider/publicationService.test.ts:414`
- **严重度 / 工作量 / 风险**: medium · medium · needs-verification
- **问题**: The startup-lock case asserts the negative `expect(publishEnteredLockedTransaction).toBe(false); expect(publishSettled).toBe(false)` only after `await new Promise(r => setTimeout(r, 100))` (line 414). Several sibling cases interleave fixed sleeps of 30ms/20ms (lines 769, 813, 815) between concurrent publish() calls to 'let recovery attempt happen'. Although the suite uses deferred-promise barriers elsewhere, these fixed sleeps encode timing assumptions: on a loaded runner the awaited operation can slip past the window, flipping the result. Same anti-pattern recurs in agentCatalog/rolloutService.test.ts (582) and identityProvider/startupSnapshot.test.ts.
- **建议修法**: repair — replace the fixed sleeps with explicit synchronization barriers (await a signal that the contended operation has reached the observable point) so the negative assertions are deterministic. These are also gated pg tests, compounding the risk that flakes go unnoticed.
- **对抗复核**: 驳回 / 保留 — The claim's line references are factually accurate (setTimeout at publicationService.test.ts:415, 769, 813, 815; rolloutService.test.ts:582, 633; startupSnapshot.test.ts:212), but its core flakiness m

### \[#88] Test exists only to keep a deferred feature wired to nothing

- **位置**: `src/enterprise/client/features/agents/pr049Deferred.test.ts:16`
- **严重度 / 工作量 / 风险**: medium · small · needs-human-confirmation — **MOOT — agents/pr049Deferred.test.ts no longer exists at that path (already removed).**
- **问题**: The suite asserts `PR049_MANAGED_AGENT_STATUS === 'deferred'` (a constant equals its own literal) and walks the whole enterprise tree to assert NO production file imports `features/agents` or references `getPlatformAgentPresentation`/`PlatformAgentManagementNotice`. In other words it enforces that a shipped-but-unwired feature (index.ts exports PlatformAgentManagementNotice + getPlatformAgentPresentation, but nothing imports them) stays dead. This is a rot signal: dead/deferred product code kept alive only by exports and tests. The self-referential first assertion has zero defect-catching power.
- **建议修法**: needs a product decision: either ship PR-049 (wire the notice in) and delete this guard, or delete the deferred feature (presentation.ts, PlatformAgentManagementNotice.tsx, index exports) together with this test and presentation.test.ts. This is delete/repair pending that call.

### \[#91] Duplicate 'output schema rejects secrets' assertion

- **位置**: `apps/server/src/enterprise/routers/admin/users.r2.test.ts:543`
- **严重度 / 工作量 / 风险**: low · small · needs-verification — **KEEP — audit refuted this as a false positive (the R2-04 block is a parametrized it.each over 7 schemas, not a duplicate).**
- **问题**: 'R2-04 strict recursive output schemas' (users.r2.test.ts:543) re-asserts the same invariant as users.rework.test.ts:169 ('M04 R1 — output schemas reject secrets' — list/get output schemas throw on password/token/accessToken fields). The contract-level version in contracts/adminUsers.test.ts already validates these schemas directly. Three near-identical guards for one Zod rejection.
- **建议修法**: repair/dedupe — keep the contract test (contracts/adminUsers.test.ts), delete the two router-level re-checks.
- **对抗复核**: 驳回 / 保留 — REFUTED — the R2-04 block is not redundant. It is a parametrized `it.each` over SEVEN output schemas (list, get, ban, unban, revokeSessions, replaceGlobalRoles, getAuditTrail), asserting each rejects

### \[#94] Tests a test-only fixture whose behavior is already exercised by consumers

- **位置**: `src/enterprise/client/features/admin/agents/mockAdminAgents.test.ts:5`
- **严重度 / 工作量 / 风险**: low · trivial · needs-verification — **KEEP — the mockAdminAgents contract test guards the mock’s CAS/rollout fidelity that the hook tests rely on; deleting it would lose real coverage.**
- **问题**: mockAdminAgents.ts is a test fixture — createMockAdminAgentsClient has no production caller (only useAdminAgents.test.ts and useAdminAgentRolloutPolling.test.tsx import it). mockAdminAgents.test.ts then tests the fixture's own filtering/CAS/rollout behavior. Testing a mock verifies the scaffolding, not the product; and those same behaviors already run through the two hook tests that consume the fixture. Low-value coverage that must be maintained in lockstep with the real client contract.
- **建议修法**: delete — remove mockAdminAgents.test.ts; the fixture is validated implicitly by the hook tests that use it. Confirm no assertion in it covers a branch the hook tests never hit before deleting.
- **对抗复核**: 确认可删 — Adversarial grep of the entire repo confirms mockAdminAgents.ts is a test-only fixture with zero production callers (no import outside \*.test files, no barrel re-export, no router/registry, no dynamic

### \[#89] Full suite tests deferred, unwired dead code

- **位置**: `src/enterprise/client/features/agents/presentation.test.ts:4`
- **严重度 / 工作量 / 风险**: low · trivial · needs-verification
- **问题**: presentation.test.ts exercises `getPlatformAgentPresentation`, which pr049Deferred.test.ts simultaneously certifies has no production caller anywhere in the codebase. So this is a well-covered test suite over code that never runs in the product. Coverage of dead code inflates confidence and keeps the deferred feature from being garbage-collected.
- **建议修法**: delete alongside the deferred feature if PR-049 is abandoned; keep only if PR-049 is scheduled to ship. Tie to the pr049Deferred decision.
- **对抗复核**: 驳回 / 保留 — The claim's premise is factually correct — getPlatformAgentPresentation has zero production callers repo-wide (verified across web/mobile/desktop/popup, routers, registries, i18n) — but the deletion i

## Database migrations (do NOT modify deployed migrations)

### \[#123] RECOMMENDATION: leave the 0117–0144 chain as-is; a squashed baseline is NOT safe for deployed demo/prod

- **位置**: `packages/database/migrations/meta/_journal.json:1`
- **严重度 / 工作量 / 风险**: medium · large · needs-human-confirmation
- **问题**: Demo/prod already carry a Drizzle \_\_drizzle\_migrations ledger with the 28 hashes 0117–0144 applied. A squash replaces those files with one baseline whose hash is absent from the ledger, so Drizzle would treat it as unapplied and RUN it against a populated DB. Even the CREATE TABLE/COLUMN/INDEX statements guarded with IF NOT EXISTS would no-op, but the chain also contains many un-guarded ADD CONSTRAINT statements, data-migration UPDATEs (0120,0123,0136), a RAISE-EXCEPTION precondition (0122), and immutability triggers (0122,0140) — replaying those on an already-migrated DB errors or corrupts. In-place squash is therefore infeasible. The only safe squash is a dual-track baseline used ONLY for brand-new installs while existing installs keep the incremental chain (or manual \_\_drizzle\_migrations ledger seeding), which is high operational risk for little gain.
- **建议修法**: Do not squash the deployed chain. If a fresh-install baseline is desired, generate it as a separate parallel artifact gated to empty databases only, and never point existing demo/prod at it. Simplest safe action: leave the chain exactly as-is.

### \[#129] Orphan migration file 0065\_add\_document\_fields.sql exists but is absent from the journal (pre-existing upstream, outside 二开 range)

- **位置**: `packages/database/migrations/0065_add_document_fields.sql:1`
- **严重度 / 工作量 / 风险**: low · trivial · needs-human-confirmation
- **问题**: Outside the requested range but surfaced by the drift cross-check: 0065\_add\_document\_fields.sql is committed (since the v2.2.10 upstream release) yet no journal entry references it — idx 65 is 0065\_add\_passkey and idx 66 is 0066\_add\_document\_fields (the real, journal-tracked file). Drizzle applies strictly by journal, so the orphan is silently ignored and causes no runtime effect; it is a leftover from an upstream merge/rename, not from the AIHub 二开 chain. Harmless but it is genuine file/journal drift.
- **建议修法**: Leave untouched unless doing an unrelated hygiene pass; deleting it is safe (Drizzle never reads it) but should be a deliberate, separate cleanup, not bundled with the 二开 migration work.

### \[#125] 0122 is environment-state-dependent (RAISE EXCEPTION precondition) but is replay-safe

- **位置**: `packages/database/migrations/0122_m08_platform_skill_versions.sql:500`
- **严重度 / 工作量 / 风险**: low · trivial · safe
- **问题**: 0122 opens with a DO block that RAISEs 'M08 requires the M01 platform Skill shell tables to be empty' when the 'content' column is absent AND platform\_skills/platform\_skill\_versions hold rows. On first apply from the empty 0117 shell this passes; on replay the 'content' column now exists so the guard short-circuits and skips. The subsequent ALTER COLUMN content/checksum SET NOT NULL and manifest DROP DEFAULT are individually replay-safe no-ops, and the zip\_hash→checksum / current\_version→current\_version\_id renames are guarded by information\_schema existence checks. So 0122 is idempotent, but note it will hard-fail if ever run against a populated pre-M08 Skill table — a deliberate data-safety stop, not a bug.
- **建议修法**: No change. Documented behavior; keep as-is.

### \[#126] 0123 correctness depends on a manual predeploy step Drizzle does not run

- **位置**: `packages/database/migrations/0123_m09_connector_catalog_predeploy.md:1`
- **严重度 / 工作量 / 风险**: low · small · needs-human-confirmation
- **问题**: The 0123 .md documents a CONCURRENTLY index prebuild (predeployM09ConnectorIndexes.ts) that must run BEFORE the migration on any populated DB, because 0123.sql intentionally hard-stops if either target table exceeds 10,000 rows and the prebuilt index is absent (fallback allowed only via the aihub.m09\_maintenance\_window GUC). Drizzle only executes the journal-listed .sql, never the .md, so the predeploy is a human ops dependency. The .md and .sql are internally consistent (fallback CREATE UNIQUE INDEX IF NOT EXISTS + row-count guard), but forgetting the predeploy on a large prod DB blocks the deploy. Same manual-predeploy pattern applies to 0119 and 0126 (CONCURRENTLY comments inline).
- **建议修法**: No file change. Ensure the deploy runbook for any populated environment runs the M09 (and M04/M10) predeploy scripts before migrate; the fallback path is only for fresh/small/self-hosted/PGlite.

### \[#124] Un-guarded ADD CONSTRAINT (CHECK/FK) across 0127/0128/0129/0130/0135/0138 makes those migrations non-idempotent on full re-apply

- **位置**: `packages/database/migrations/0127_m11_oidc_provider_security_foundation.sql:78`
- **严重度 / 工作量 / 风险**: low · small · needs-human-confirmation
- **问题**: Unlike tables/columns/indexes (uniformly IF NOT EXISTS) and the FK adds in 0117/0121/0123/0124 (wrapped in DROP CONSTRAINT IF EXISTS or DO/duplicate\_object), these files add constraints bare: e.g. 0127 lines 78–112 (platform\_identity\_providers CHECK constraints on a table created back in 0117), plus the single FK ADD in 0128:38, 0129:55, 0130:65, 0135:37, 0138:48, and 0123's SET NOT NULL/VALIDATE pairs. On a fresh apply they succeed; on a full manual replay (or DR rebuild that recreates objects out-of-band) the CREATE TABLE IF NOT EXISTS skips but the ADD CONSTRAINT raises 'constraint already exists'. This never fires under normal Drizzle operation (apply-once by ledger hash), so impact is confined to manual replay / baseline-rebuild scenarios — but the guard style is inconsistent with the rest of the chain.
- **建议修法**: No edit to deployed files. If you ever need a replay-safe variant (e.g. for a fresh-install baseline), wrap each ADD CONSTRAINT in DO $$ BEGIN ... EXCEPTION WHEN duplicate\_object THEN null; END $$ or precede with DROP CONSTRAINT IF EXISTS, matching the 0117/0124 pattern.

### \[#127] 0144 EasyAuth drop is consistent and idempotent; 0118 counterpart correctly bracketed

- **位置**: `packages/database/migrations/0144_drop_platform_easyauth_snapshots.sql:1`
- **严重度 / 工作量 / 风险**: low · trivial · safe
- **问题**: 0118 created platform\_easyauth\_grant\_snapshots (with a CASCADE FK to users, added via a duplicate\_object-guarded DO block); 0144 removes it with a single DROP TABLE IF EXISTS, which also drops that FK automatically. This is idempotent (re-apply = no-op) and consistent with the EasyAuth-removal / Authentik-only direction recorded in project history. No dangling FK, index, or snapshot reference to the table remains in the chain. A future baseline would simply omit both 0118 and 0144.
- **建议修法**: No change needed; the 0118/0144 create/drop pair is clean.

### \[#128] No journal/SQL/snapshot drift within 0117–0144 (145/145 aligned, when-values monotonic)

- **位置**: `packages/database/migrations/meta/_journal.json:1`
- **严重度 / 工作量 / 风险**: low · trivial · safe
- **问题**: Verified: 145 journal entries ↔ 145 meta \*\_snapshot.json files ↔ every journal tag has a matching .sql; every 0117–0144 .sql appears in the journal. The 'when' values across the range are strictly monotonic increasing with zero inversions, so folderMillis apply-order matches idx order. Entries 0140/0142/0143/0144 carry hand-rounded 'when' values (1784700000000 / 1784800000000 / 1784800100000 / 1784800200000) that were manually inflated to outrank concurrently-authored migrations; all four are now below the current clock (\~1784803842859), so future real-timestamp migrations will sort after them correctly and the earlier collision hazard is neutralized.
- **建议修法**: No change. Recorded as confirmation that the target range has no drift.

## 附：阻碍进一步验证的环境限制（非代码问题）

- 缺 `@electric-sql/pglite` — `packages/database` 的 DB 集成测试无法运行。
- 缺 `@thi.ng/base-n` — 经 `builtin-tool-calculator` 传递引入，致部分客户端测试套件无法加载。
  （两者均不在 lockfile，安装会改动 lockfile。）
- `bun run check` 的 `enterprise:check-branding` 门禁在 `apps/cli/pnpm-lock.yaml` 上**既有失败**（把 `@lobehub/*` 包名判为 new-user-visible-literal）；需更新审阅基线。
- 无可运行的应用 / 构建环境，无法对性能与端到端行为做验证。
