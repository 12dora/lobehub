# Partition: agents

## Summary

The partition has strong authorization, secret-handling, route-isolation, and migration safeguards, but three serious correctness gaps affect committed mutations, version selection, and materialization provenance. CRITICAL: 0 · HIGH: 3 · MEDIUM: 3 · LOW: 2.

## Findings

### F1 \[HIGH]\[D5] Draft-only commits permanently engage the refresh lock

- **Location:** `src/enterprise/client/features/admin/agents/AgentDetailView.tsx:56`, `src/enterprise/client/features/admin/agents/useAssignmentEditor.ts:193`, `src/enterprise/client/features/admin/agents/RolloutPanel.tsx:91`, `apps/server/src/enterprise/services/agentCatalog/adminService.ts:349`, `apps/server/src/enterprise/services/agentCatalog/rolloutService.ts:601`, `apps/server/src/enterprise/services/agentCatalog/publication.ts:46`, `packages/database/src/schemas/platform/agents.ts:77`
- **Evidence:** Freshness requires both a strictly higher revision and a changed token: `if (fresh.identity.revision <= baseline.identity.revision) return false`. Assignment upsert/removal and pinned rollout rollback call `updateDraftCas`, advancing the independently documented `draftSequence` but not the published `revision`. The token explicitly includes both fields: `draftSequence: identity.draftSequence` and `revision: identity.revision`. The clients nevertheless call `lock.markCommitted(...)` followed by `lock.commitWrite(...)`.
- **Impact / failure scenario:** An administrator creates, updates, or removes an assignment—or rolls back a pinned rollout. The database commit succeeds and changes `draftSequence`/`draftToken`, while `revision` remains equal. Every authoritative refresh is rejected as stale, so the detail page remains locked with refresh-failed state and all further writes are disabled until an external revision-changing operation or full reload.
- **Fix:** Accept a complete same-agent aggregate when either `draftSequence` or `revision` advances monotonically and the draft token changes; continue rejecting decreases and unchanged CAS. Add regressions for assignment mutation and pinned rollout rollback.
- **Confidence:** HIGH

### F2 \[HIGH]\[D5] The UI publishes and edits an arbitrarily ordered version

- **Location:** `packages/database/src/schemas/platform/agents.ts:124`, `apps/server/src/enterprise/services/agentCatalog/adminService.ts:316`, `src/enterprise/client/features/admin/agents/useAdminAgents.ts:83`, `src/enterprise/client/features/admin/agents/useAgentEditor.ts:20`, `src/enterprise/client/features/admin/agents/AgentDetailView.tsx:82`
- **Evidence:** Version IDs are opaque generated identifiers. `listVersions` forwards repository pages without defining an order, and `fetchAdminAgentDetail` concatenates them without sorting. The editor uses `snapshot.versions[0] ?? current`, making the current-version fallback unreachable whenever any version exists. The detail view similarly defines `const latest = snapshot.versions[0]` and publishes `latest.id`.
- **Impact / failure scenario:** After multiple versions exist, lexicographic opaque-ID order need not match creation order. Reloading the page can seed a new draft from an older version, hide the publish action when that older version happens to be current, or publish an arbitrary historical version instead of the most recently created draft.
- **Fix:** Define a canonical order and enforce it at the aggregate boundary, such as descending `createdAt` with an ID tie-breaker. Select current and latest versions through explicit helpers rather than array position. ADD regression tests using shuffled versions with distinct creation times.
- **Confidence:** HIGH

### F3 \[HIGH]\[D5] Disabling managed agents leaks materialized clones into ordinary local-agent lists

- **Location:** `apps/server/src/enterprise/services/agentCatalog/userListProjection.ts:98`, `apps/server/src/enterprise/services/agentCatalog/userListProjection.ts:152`, `apps/server/src/enterprise/services/agentCatalog/userListProjection.ts:201`, `apps/server/src/enterprise/services/agentCatalog/userListProjection.ts:241`, `apps/server/src/enterprise/services/agentCatalog/userListProjection.ts:268`, `apps/server/src/enterprise/services/agentCatalog/userListProjection.test.ts:110`, `apps/server/src/enterprise/services/agentCatalog/userListProjection.test.ts:404`
- **Evidence:** With the feature flag enabled, the service always reads `listMaterializedAgentIds` because hidden, revoked, and tombstoned materializations must never reappear as editable local clones. With the flag disabled, all three list paths immediately return legacy/base data and explicitly avoid that provenance read. The tests lock in zero materialization queries on the disabled path.
- **Impact / failure scenario:** A user materializes a managed agent, then an operator disables the feature flag during rollback or maintenance. The durable materialization/tombstone remains, but picker, sidebar, and search stop filtering its local row. Managed content reappears as an ordinary local assistant and routes through ordinary editable/local behavior.
- **Fix:** Separate catalog projection from durable provenance enforcement. When the feature is disabled, skip effective-agent resolution but still read owner-scoped materialized/tombstoned local IDs and strip them from legacy lists. FIX the flag-off tests to assert this fail-closed behavior.
- **Confidence:** HIGH

### F4 \[MEDIUM]\[D2] Client mocks model the wrong CAS and conceal the production refresh-lock defect

- **Location:** `src/enterprise/client/features/admin/agents/__tests__/mockAdminAgents.ts:195`, `src/enterprise/client/features/admin/agents/__tests__/mockAdminAgents.ts:203`, `src/enterprise/client/features/admin/agents/__tests__/mockAdminAgents.ts:398`, `src/enterprise/client/features/admin/agents/__tests__/mockAdminAgents.ts:516`, `apps/server/src/enterprise/services/agentCatalog/adminService.test.ts:115`, `src/enterprise/client/features/admin/agents/useRefreshLock.test.ts:121`
- **Evidence:** The mock derives its token solely from revision and `advanceAgent` always increments revision. Assignment mutations call that helper. Production service tests instead model assignment CAS as `{ ...locked, draftSequence: 5 }`, leaving revision unchanged. Refresh-lock tests explicitly require a token-only change at equal revision to remain locked.
- **Impact / failure scenario:** Integration tests using the mock observe assignment writes advancing revision and successfully unlocking, while the production response advances only draft CAS. The test environment therefore cannot reproduce F1 and positively asserts the stale behavior.
- **Fix:** FIX the mock to track `draftSequence` independently, derive tokens from the same complete identity fields as `platformAgentDraftToken`, and increment revision only for publication lifecycle changes. Add an assignment-write integration regression through the real lock chain.
- **Confidence:** HIGH

### F5 \[MEDIUM]\[D5] Fixed five-times overscan can omit entitled agents

- **Location:** `apps/server/src/enterprise/services/agentCatalog/effectiveResolver.ts:25`, `apps/server/src/enterprise/services/agentCatalog/effectiveResolver.ts:153`, `apps/server/src/enterprise/services/agentCatalog/effectiveResolver.ts:189`, `apps/server/src/enterprise/services/agentCatalog/effectiveResolver.test.ts:101`
- **Evidence:** The resolver limits effective-input rows to `1000 * 5`, de-duplicates only after that limit, then applies hidden filtering and slices to 1000. The factor is a heuristic; neither assignment multiplicity nor the number of hidden agents is bounded by five. Tests cover 1,000 hidden entries followed by 50 visible entries, all still within the 5,000-row window.
- **Impact / failure scenario:** If the first 5,000 ordered input rows are duplicate assignments or hidden optional agents, later mandatory or visible agents are never loaded. The effective list can return fewer than 1,000 entries—or even empty—despite entitled agents existing beyond the arbitrary window.
- **Fix:** Replace one-shot overscan with stable cursor paging until 1,000 visible unique winners are collected or the source is exhausted; alternatively require the repository query to de-duplicate and apply hidden policy before its final limit. ADD regressions exceeding five matching rows per agent and 5,000 leading hidden rows.
- **Confidence:** HIGH

### F6 \[MEDIUM]\[D5] Valid SemVer prerelease and build versions produce `NaN` drafts

- **Location:** `src/enterprise/client/features/admin/agents/useAgentEditor.ts:15`, `src/enterprise/client/features/admin/agents/useAgentEditor.ts:20`, `src/enterprise/client/features/admin/agents/useAgentEditor.ts:175`
- **Evidence:** `nextVersion` splits on periods and evaluates `Number(patch) + 1`. A valid version such as `1.2.3+build.5` selects patch text `3+build`, producing `1.2.NaN`; prerelease forms fail similarly. This helper runs during initial hydration and after every successful save.
- **Impact / failure scenario:** Opening an agent whose selected source version contains valid SemVer metadata initializes an invalid next version. Save then fails contract validation until the administrator manually repairs the field.
- **Fix:** Use a SemVer parser/incrementer with an explicit prerelease/build policy. ADD tests for prerelease and build-metadata inputs.
- **Confidence:** HIGH

### F7 \[LOW]\[D5] Production assignment preview never emits its mandatory-mode warning

- **Location:** `apps/server/src/enterprise/services/agentCatalog/adminService.ts:326`, `apps/server/src/enterprise/services/agentCatalog/adminService.test.ts:613`, `src/enterprise/client/features/admin/agents/__tests__/mockAdminAgents.ts:371`, `src/enterprise/client/features/admin/agents/AssignmentPanel.tsx:159`
- **Evidence:** The production warning type includes `MANDATORY_AGENT_CANNOT_BE_HIDDEN`, but the implementation only tests `assignment.enabled` and returns either `[]` or `['ASSIGNMENT_DISABLED']`. The client mock emits the mandatory warning, and the UI has rendering support for every returned warning. Server tests cover only the disabled case.
- **Impact / failure scenario:** An administrator previews a mandatory assignment but receives no warning that affected users cannot hide the agent, even though mock-backed UI behavior suggests the warning exists.
- **Fix:** Build warnings independently: add the disabled warning when disabled and the mandatory warning when `mode === 'mandatory'`. ADD a server regression, including the disabled-plus-mandatory combination, and align the mock.
- **Confidence:** HIGH

### F8 \[LOW]\[D3] A tested SWR list-key helper has no production caller

- **Location:** `src/enterprise/client/features/admin/agents/swrKeys.ts:7`, `src/enterprise/client/features/admin/agents/swrKeys.test.ts:3`, `src/enterprise/client/features/admin/agents/useAdminAgents.ts:175`
- **Evidence:** `buildAdminAgentListKey` is exported and tested, but repository-wide references are limited to its definition and test. The live infinite list constructs a different key inline: `[ADMIN_AGENT_LIST_KEY, input, cursor]`.
- **Impact / failure scenario:** The dead helper and its tests imply production list-key coverage while the actual cursor-aware key can evolve independently, creating misleading maintenance confidence.
- **Fix:** DELETE the unused helper and its dedicated assertions, or refactor the live infinite-key callback to use a cursor-aware shared builder.
- **Confidence:** HIGH

## Dimension coverage

① Code smells — Checked service size, responsibility boundaries, pagination, query bounds, cleanup, and exception handling; no standalone smell was reportable, although F5 exposes a bounded-query heuristic with correctness consequences.

② Test rot — F4 is a production-inaccurate mock/test model requiring FIX; missing regressions are identified for F1, F2, F5, F6, and F7. Environment-gated PostgreSQL suites were legitimate rather than stale skips.

③ Dead code & dev cruft — F8 is confirmed dead tested code; no leftover debug output, committed artifacts, or stale TODO/FIXME material was found.

④ Missing Simplified-Chinese i18n — Clean: referenced `admin` agent-catalog keys exist, en-US and zh-CN key sets align, and no agent-catalog zh-CN values remain untranslated English.

⑤ Functional bugs — Issues cluster in draft-CAS freshness, version-order contracts, feature-flag provenance handling, effective-list completeness, SemVer incrementing, and preview warnings. Authorization, hard-delete guards, secret-draft filtering, SWR route isolation, and migration behavior were clean.
