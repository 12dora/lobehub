## Partition: agents-server

Scope reviewed: `apps/server/src/enterprise/services/agentCatalog/**`
Files examined: 28 TypeScript files, 10,215 lines; including admin, publication, resolution, materialization, rollout services, workers, and tests.

### Summary

The catalog has strong transaction boundaries, dependency validation, dual-registry coverage, and PostgreSQL guards for exact-version publication and version immutability. The largest risks are in hard deletion: its optional, incomplete concurrency guard permits stale destructive writes, and deleting provenance mappings reclassifies surviving materialized assistants as ordinary user agents. Effective resolution also has an unbounded cardinality mismatch with its 1,000-item API contract. Test coverage is broad but misses these destructive and scale boundaries, while warning localization and several maintenance issues remain.

### Findings

#### \[HIGH] Hard delete accepts stale state and can destroy concurrent changes

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/agentCatalog/adminService.ts:577`
- **Problem:** Hard delete accepts an optional revision and never checks the draft token or `draftSequence`. Even a supplied revision does not detect version appends, assignment mutations, or draft updates because those advance `draftSequence` without necessarily advancing `revision`.
- **Evidence:** The only guard is `if (typeof input.expectedRevision === 'number' && locked.revision !== input.expectedRevision)`. The contract makes `expectedRevision` optional, and the list-page delete client sends only `{ agentId, reason }`.
- **Impact / failure scenario:** Admin A opens the delete confirmation for a draft. Admin B appends and publishes a version or adds an assignment. Admin A then confirms using stale UI state; the service locks the latest row and irreversibly deletes the newly created immutable versions, assignments, and materializations.
- **Recommendation:** Require `expectedDraftToken` and `expectedRevision`, then call `assertExpectedPlatformAgentIdentity` after locking. Have list-originated deletion fetch authoritative detail before confirmation. Add concurrent append-version, assignment-upsert, and publication-versus-delete regression tests.

#### \[HIGH] Hard delete turns managed materializations into editable local assistants

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/agentCatalog/adminService.ts:559`
- **Location:** `apps/server/src/enterprise/services/agentCatalog/userListProjection.ts:158`
- **Problem:** Hard delete removes materialization mappings while deliberately preserving their local `agents` rows. List de-duplication and managed-agent mutation/runtime guards identify materialized rows solely through those mappings.
- **Evidence:** The delete documentation says, “The user's local `agents` rows are preserved,” before calling `hardDeleteAgentCascade`. The projection excludes only IDs returned by `listMaterializedAgentIds(userId)`. Repository verification confirms the cascade deletes `platform_user_agent_materializations` but not the local agent.
- **Impact / failure scenario:** A user materializes a managed assistant. An administrator hard-deletes its platform identity. On the user’s next picker/sidebar/search load, the surviving local clone is no longer excluded; reverse lookup also returns no platform identity, so the clone can be edited and executed as an ordinary assistant, retaining managed prompt/model content outside entitlement and immutability controls.
- **Recommendation:** Preserve a durable tombstone/provenance classification independent of the live catalog, keeping surviving attribution rows excluded and guarded. Alternatively, migrate historical references and delete the local rows safely. Add picker, sidebar, runtime, and mutation-guard tests for post-delete materializations.

#### \[MEDIUM] Effective resolution is unbounded and violates the 1,000-agent output contract

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/services/agentCatalog/effectiveResolver.ts:120`
- **Location:** `apps/server/src/enterprise/services/agentCatalog/effectiveResolver.ts:158`
- **Problem:** `resolveAuthorized` loads every effective assignment, sorts the full result in memory, and has no limit. Single-agent operations such as `beginOperation`, `isEntitled`, and `getEffectiveAgent` also resolve the entire catalog.
- **Evidence:** `const rows = await this.repository().listEffectiveInputs(userId); rows.sort(...)` has no bound. The router’s `platformAgentEffectiveListOutputSchema` permits at most 1,000 agents, while the repository query has no corresponding limit.
- **Impact / failure scenario:** With 1,001 published globally assigned assistants, `getEffectiveList` produces 1,001 entries and tRPC output validation fails instead of returning the catalog. Every targeted runtime lookup also reads and sorts all 1,001 assignments, making chat-start latency grow with catalog size.
- **Recommendation:** Enforce an explicit catalog cardinality invariant or introduce pagination. Add targeted repository queries for single-agent/system-role entitlement checks rather than loading the full list. Test the 1,000/1,001 boundary and large targeted lookups.

#### \[MEDIUM] Assignment preview returns prose where the client expects an i18n warning code

- **Dimension:** 4 / Missing Simplified-Chinese i18n
- **Location:** `apps/server/src/enterprise/services/agentCatalog/adminService.ts:339`
- **Problem:** The backend returns a hardcoded English sentence in `warnings`, but the frontend treats each warning as a code and translates `agentCatalog.assignment.warning.${warning}`.
- **Evidence:** The service returns `['Assignment is disabled and will not take effect']`. The client constructs an i18n key from that value, while en-US and zh-CN contain only the coded warning `MANDATORY_AGENT_CANNOT_BE_HIDDEN`.
- **Impact / failure scenario:** Previewing a disabled assignment renders a missing-key string such as `agentCatalog.assignment.warning.Assignment is disabled and will not take effect`; Chinese administrators do not receive a valid zh-CN message.
- **Recommendation:** Define warning codes as a shared enum in the contract, return a code such as `ASSIGNMENT_DISABLED`, and add matching hand-authored en-US and zh-CN keys. Add a contract/UI integration test for every warning code.

#### \[LOW] Critical hard-delete and scale regressions are absent from the in-scope suites

- **Dimension:** 2 / Test rot
- **Location:** `apps/server/src/enterprise/services/agentCatalog/adminService.test.ts:105`
- **Location:** `apps/server/src/enterprise/services/agentCatalog/effectiveResolver.test.ts:72`
- **Problem:** The service suites do not exercise hard deletion, stale deletion concurrency, post-delete materialization classification, or the effective-list output limit.
- **Evidence:** Repo-wide inspection found no `PlatformAgentAdminService.delete` call in the in-scope tests. Existing external router coverage tests only basic draft deletion and default rejection; repository coverage explicitly preserves the local row but never passes it through list/runtime/mutation classification.
- **Impact / failure scenario:** The stale-delete race, managed-clone escape, and 1,001-agent output failure can ship despite otherwise extensive unit and PostgreSQL coverage.
- **Recommendation:** Add named regressions: `rejects delete after draftSequence changes`, `post-delete materialization remains managed/tombstoned`, and `effective list handles the 1000/1001 boundary`.

#### \[LOW] Two test suites exceed the repository’s file-size guideline

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/services/agentCatalog/adminService.pg.test.ts:1`
- **Location:** `apps/server/src/enterprise/services/agentCatalog/rolloutService.test.ts:1`
- **Problem:** The suites combine unrelated pagination, constraint normalization, locking, lifecycle, and rollout state-machine scenarios in files above the repository’s \~800-line threshold.
- **Evidence:** `adminService.pg.test.ts` is 1,180 lines and `rolloutService.test.ts` is 975 lines.
- **Impact / failure scenario:** Large shared setup increases merge conflicts and makes focused ownership or execution difficult; future coverage is more likely to accumulate in already tangled suites.
- **Recommendation:** Split the admin suite into pagination, default/archive concurrency, reference locking, and PG-error normalization files. Split rollout coverage into control-plane, worker batching/retry, and rollback-proof suites.

#### \[LOW] Rollout rollback bypasses the repository logging convention

- **Dimension:** 3 / Dead code & dev cruft
- **Location:** `apps/server/src/enterprise/services/agentCatalog/rolloutService.ts:706`
- **Problem:** The rollback invalidation failure path uses `console.error` even though the module already defines a namespaced `debug` logger.
- **Evidence:** `console.error('[platform-agent-rollout:rollback] invalidation failed', ...)` appears alongside `const log = debug('lobe-server:platform-agent-rollout')`.
- **Impact / failure scenario:** Expected post-commit invalidation failures produce unconditional stderr noise and inconsistent log filtering/formatting compared with the rest of the service.
- **Recommendation:** Replace it with the existing namespaced `log`, retaining only low-cardinality identifiers and error class.

### Metrics

- Total findings: 7 (CRITICAL 0, HIGH 2, MEDIUM 2, LOW 3)
- Largest in-scope files (lines): `adminService.pg.test.ts` 1,180; `rolloutService.test.ts` 975; `rolloutService.ts` 739
- Dead-code candidates verified unused repo-wide: 0
