## Partition: agents-client

Scope reviewed: `src/enterprise/client/features/admin/agents` and `src/enterprise/client/features/agents`
Files examined: 56 TypeScript/TSX files (10,215 lines), plus agentCatalog contracts, services, registries, locale catalogs, routing, and SWR behavior for verification

### Summary

The admin implementation is generally contract-typed and careful about dependency validation, but two serious concurrency defects remain: retained SWR detail can expose the wrong agent, and hard delete drops an available revision guard. Rollout and delete refresh failures can leave stale, actionable UI, while detail and preflight reads eagerly drain entire paginated collections. The zh-CN catalogs are otherwise aligned, but two runtime paths bypass localization. The user-facing agents feature and several legacy SWR helpers are unwired dead code. No file exceeds 800 lines; hard delete is confirmed and non-optimistic, so no optimistic-rollback defect was found.

### Findings

#### \[HIGH] Retained detail data exposes the previous agent under a new agent URL

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/agents/useAdminAgents.ts:203`; `src/enterprise/client/features/admin/agents/AgentDetailPage.tsx:33`
- **Problem:** The identity-changing detail query enables SWR `keepPreviousData`, but the page never verifies that the returned identity matches the current route parameter.
- **Evidence:** The hook sets `keepPreviousData: true`. The page immediately calls `useAgentEditor(data)`, suppresses errors with `error={data ? undefined : error}`, and renders `snapshot={data}` without checking `data.identity.id === id`.
- **Impact / failure scenario:** After loading agent A, an admin navigates client-side to `/admin/agents/B`. While B loads, the page displays A and exposes actions targeting A. If B’s request fails generically, A remains indefinitely and the B error is hidden. Clicking publish, archive, assignment, or rollback under B’s URL mutates A.
- **Recommendation:** Remove `keepPreviousData` for identity-changing detail keys, or expose data only when `data.identity.id === id`. Reset the editor/action surface during transitions and never suppress the current key’s error using retained data. Add a regression test named `switching A to B never renders or mutates A under B, including when B fails`.

#### \[HIGH] Hard delete omits the available revision CAS guard

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/agents/AgentListPage.tsx:117`; `src/enterprise/client/features/admin/agents/openDeleteAgentModal.tsx:26`
- **Problem:** The list row carries `identity.revision`, but the deletion flow discards it and sends only `agentId` and `reason`.
- **Evidence:** `buildPayload` returns `{ agentId: params.agentId, reason }`. The server’s `adminPlatformAgentDeleteInputSchema` accepts `expectedRevision`, and `adminService.delete` rejects stale revisions only when that field is supplied.
- **Impact / failure scenario:** Admin A opens a row at revision 3. Admin B publishes or edits it to revision 4. Admin A then confirms the irreversible cascade delete; because no revision is sent, revision 4 is deleted instead of returning a conflict.
- **Recommendation:** Pass `item.identity.revision` through `openDeleteAgentModal` as `expectedRevision`. Add a regression test proving a stale list row sends its revision and receives a conflict without removing the row.

#### \[MEDIUM] A failed post-delete refresh leaves a stale row and an unhandled rejection

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/agents/AgentListPage.tsx:129`; `src/enterprise/client/features/admin/agents/openDeleteAgentModal.tsx:43`
- **Problem:** The post-delete callback fire-and-forgets the bound SWR refresh, so its rejection is neither returned nor caught.
- **Evidence:** The callback executes `void refreshList()`. The modal has already completed `adminAgentsService.delete(...)` and shown the success toast before awaiting a callback that immediately returns `undefined`.
- **Impact / failure scenario:** The delete commits, but the subsequent list request fails due to a network outage. The modal closes and reports success, the deleted row remains actionable, and the rejected refresh promise becomes unhandled. Selecting the stale row then leads to a not-found page.
- **Recommendation:** Catch and await the refresh without converting the committed deletion into a false mutation failure, and expose a retryable refresh warning. Alternatively, remove the row from the bound SWR pages after commit; if removal becomes optimistic before the request, explicitly restore it when deletion fails. Test the rejected-refresh path.

#### \[MEDIUM] Rollout writes bypass the shared post-commit freshness lock

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/agents/AssignmentPanel.tsx:39`; `src/enterprise/client/features/admin/agents/AssignmentPanel.tsx:212`; `src/enterprise/client/features/admin/agents/RolloutPanel.tsx:43`; `src/enterprise/client/features/admin/agents/AgentDetailView.tsx:291`
- **Problem:** The detail view claims its refresh lock covers every dependent write, but it is not passed to `RolloutPanel`, and Start rollout remains enabled while the assignment editor reports that lock as engaged.
- **Evidence:** Start calls the service and `mutate()` directly, while its button lacks `disabled={editor.locked}`. `RolloutPanel` similarly performs rollback and records only local `refreshFailed` state. Server rollback advances the agent identity revision/draft CAS, but the shared lock is never marked committed.
- **Impact / failure scenario:** A rollout rollback commits and advances the agent CAS, then detail refresh fails. The warning appears only inside the rollout panel while publish and assignment controls remain usable with the old snapshot; subsequent writes fail as stale conflicts. Likewise, Start remains usable after another committed write has already locked the stale detail surface.
- **Recommendation:** Pass the shared lock into rollout controls. Use its begin/commit lifecycle for identity-changing rollback, gate Start when the lock is engaged, and distinguish committed-refresh failure from mutation failure. Add regressions named `rollback refresh failure locks agent writes` and `Start is disabled while detail refresh is required`.

#### \[MEDIUM] Detail and action preflights drain entire paginated collections

- **Dimension:** 1 / Code smells
- **Location:** `src/enterprise/client/features/admin/agents/useAdminAgents.ts:31`; `src/enterprise/client/features/admin/agents/useAdminAgents.ts:47`; `src/enterprise/client/features/admin/agents/useAgentActions.tsx:281`; `src/enterprise/client/features/admin/agents/AgentDetailView.tsx:244`
- **Problem:** `collectPages` follows cursors without a page bound, and every detail load drains assignments, rollouts, and versions before rendering. Default/archive preflights also fetch the complete agent catalog.
- **Evidence:** The `do…while (cursor)` loop appends every page. `fetchAdminAgentDetail` starts three complete page drains with `limit: 100`; the resulting arrays are rendered with unrestricted `.map(...)`. `fetchAllAdminAgents` is used for default lookup and replacement candidates.
- **Impact / failure scenario:** An established agent with thousands of versions, assignments, or rollout jobs triggers dozens of sequential requests per collection and produces a very large DOM. One late-page failure rejects the whole aggregate. Large organizations also fetch every agent before opening default/archive confirmation.
- **Recommendation:** Keep list/detail state paginated by collection, render initial pages independently, add load-more or virtualization, and detect repeated cursors. Use a dedicated default-pointer read and a searchable paginated replacement picker instead of loading the full catalog.

#### \[MEDIUM] Rollout failures render raw backend messages instead of localized safe copy

- **Dimension:** 4 / Missing simplified-Chinese (zh-CN) i18n
- **Location:** `src/enterprise/client/features/admin/agents/openAgentReasonModal.tsx:22`; `src/enterprise/client/features/admin/agents/RolloutPanel.tsx:47`; `src/enterprise/client/features/admin/agents/errorPresentation.ts:34`
- **Problem:** The rollout-specific modal displays `Error.message` or `String(cause)` directly, bypassing both react-i18next and the existing sanitized agent error mapper.
- **Evidence:** Its catch block calls `setError(cause instanceof Error ? cause.message : String(cause))`, while `getAdminAgentErrorMessage` explicitly promises localized copy that “Never returns an untrusted backend message.”
- **Impact / failure scenario:** If cancel/retry/rollback rejects with `Error('database unavailable')`, a zh-CN admin sees English text. A transport or improperly sanitized server error could also expose internal identifiers or database details.
- **Recommendation:** Reuse the shared reason modal or map failures through `getAdminAgentErrorMessage(cause, t)`. Add a test proving an unknown English/SQL-like message renders the zh-CN generic error and never the raw text.

#### \[MEDIUM] New agents receive a hardcoded English system prompt

- **Dimension:** 4 / Missing simplified-Chinese (zh-CN) i18n
- **Location:** `src/enterprise/client/features/admin/agents/useAgentEditor.ts:35`; `src/enterprise/client/features/admin/agents/AgentEditorFields.tsx:67`
- **Problem:** The first-version draft initializes the visible system-role field with hardcoded English rather than a locale key.
- **Evidence:** The default is `'You are a helpful organization Agent.'`; repo-wide locale search found no corresponding default-system-role key, and the value is displayed directly in the editor.
- **Impact / failure scenario:** A Chinese admin creates an agent with no versions and immediately sees English. Saving the untouched draft persists that English prompt, affecting the managed agent’s runtime behavior.
- **Recommendation:** Add an `agentCatalog.editor.defaultSystemRole` key to the English source and hand-authored zh-CN catalog, then initialize the draft from `t()`. Cover both locales in the first-version editor test.

#### \[LOW] Superseded SWR hooks and cache helpers have no production callers

- **Dimension:** 3 / Dead code & dev cruft
- **Location:** `src/enterprise/client/features/admin/agents/useAdminAgents.ts:100`; `src/enterprise/client/features/admin/agents/useAdminAgents.ts:238`
- **Problem:** `useFetchAdminAgents`, `refreshAdminAgentLists`, `refreshAdminAgent`, and `clearAdminAgentCache` are exported but unused by production code.
- **Evidence:** Repo-wide searches find only their definitions and tests. The active list uses `useAdminAgentListPagination` and its bound `refresh`; the file itself warns that global predicate refresh is unreliable for `useSWRInfinite`.
- **Impact / failure scenario:** These APIs increase maintenance cost and invite future callers to use the known-incoherent global invalidation path, potentially leaving infinite list pages stale.
- **Recommendation:** Delete the four unused exports and their dedicated tests. If a cross-page cache API is genuinely required, implement it around the active infinite-cache key shape and add a real consumer first.

#### \[LOW] The ordinary-user agents feature is intentionally shipped with no runtime consumer

- **Dimension:** 3 / Dead code & dev cruft
- **Location:** `src/enterprise/client/features/agents/index.ts:1`; `src/enterprise/client/features/agents/PlatformAgentManagementNotice.tsx:14`; `src/enterprise/client/features/agents/presentation.ts:15`
- **Problem:** The directory exports a status constant, component, and presentation adapter that are explicitly not wired into any product surface.
- **Evidence:** The barrel states “DEFERRED and NOT wired into production.” Repo-wide searches find no production importer outside this directory; references are limited to its own exports, component, and tests.
- **Impact / failure scenario:** The code contributes no user-facing tag, visibility, or dedupe behavior, yet must be maintained alongside the active implementation elsewhere. Future developers may mistake these exports for the authoritative user-agent integration.
- **Recommendation:** Make a product decision: wire the feature through an approved in-scope mount point, or delete `PlatformAgentManagementNotice`, `presentation`, the status export, and their locale-only support. Do not preserve an indefinite deferred implementation.

#### \[LOW] Tests enforce and exercise dead code instead of critical race regressions

- **Dimension:** 2 / Test rot
- **Location:** `src/enterprise/client/features/agents/pr049Deferred.test.ts:17`; `src/enterprise/client/features/agents/presentation.test.ts:29`; `src/enterprise/client/features/admin/agents/useAdminAgents.test.ts:147`
- **Problem:** Tests assert that a literal equals itself, recursively scan the enterprise tree to ensure a feature remains unused, exercise the unused presentation helper, and validate unused global cache helpers.
- **Evidence:** `expect(PR049_MANAGED_AGENT_STATUS).toBe('deferred')` has no behavioral value; the next test expects the production-caller list to remain empty. Meanwhile, no test covers A→B retained detail, delete revision CAS, rejected delete refresh, or rollout rollback’s shared-lock lifecycle.
- **Impact / failure scenario:** The suite preserves dead APIs and reports coverage while the highest-risk identity and destructive-action races remain unprotected.
- **Recommendation:** Delete these cases together with their dead implementations. Add the named regressions from the findings above: cross-agent retained-data transition, hard-delete revision conflict, rejected post-delete refresh, and post-rollback refresh-lock enforcement.

### Metrics

- Total findings: 10 (CRITICAL 0, HIGH 2, MEDIUM 5, LOW 3)
- Largest in-scope files (lines): `DependencyEditor.test.tsx` 797; `writeLockChain.test.tsx` 574; `__tests__/mockAdminAgents.ts` 539
- Dead-code candidates verified unused repo-wide: 7
