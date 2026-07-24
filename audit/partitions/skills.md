## Partition: skills

Scope reviewed: `apps/server/src/enterprise/services/skillCatalog`, `src/enterprise/client/features/admin/skills`, and `src/enterprise/client/features/skills`
Files examined: 57 TypeScript/TSX files, including 22 server service/test files and 35 client feature/test files

### Summary

The catalog has strong CAS, authorization, cache-invalidation, and fail-closed runtime foundations, but publication accepts payloads that the runtime explicitly refuses to execute. The admin import pipeline is lossy: parsed package metadata can be replaced by a synthetic minimal manifest, while partial resource imports are not represented in the conversion API. Cursor pagination also permits duplicate navigation during retained-data fetches. Tests are generally substantial, but one integration test actively blesses the non-executable publication state, and several dead paths and oversized/state-heavy files have accumulated.

### Findings

#### \[HIGH] Publication accepts opaque payloads that disable the managed Skill runtime

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/skillCatalog/publication.ts:81`; `apps/server/src/enterprise/services/skillCatalog/readService.ts:309`; `apps/server/src/enterprise/services/skillCatalog/runtimeSnapshot.ts:84`; `src/enterprise/client/features/admin/skills/openVersionEditorModal.tsx:114`
- **Problem:** Publication validation permits non-null Skill/resource `contentRef` values, while the runtime-readiness path categorically rejects them. The admin editor explicitly exposes `contentRef`, so an administrator can publish a version that makes the entire managed catalog non-executable.
- **Evidence:** Publication rejects only validation issues: `if (errors.length > 0) throw new SkillCatalogValidationError(errors)`. The validator emits no execution-readiness error for `contentRef`, but the read service sets `executionReady = false` when `resolved.contentRef !== null` or a resource is not inline. Runtime snapshot creation then throws `Published Skill catalog is not execution-ready`.
- **Impact / failure scenario:** An administrator creates a valid version with `contentRef: "opaque:skill-content-1"` and publishes it. Publication succeeds and advances the global catalog; subsequent managed-agent operations fail before execution because readiness is false—even if every other Skill is valid.
- **Recommendation:** Either materialize and integrity-check referenced content before runtime use, or reject any non-inline Skill/resource at validation/publication time with a dedicated validation code. Add an integration regression test proving a successfully published catalog is immediately accepted by `resolvePlatformSkillRuntimeSnapshot`.

#### \[MEDIUM] Parsed imports are converted into a lossy synthetic manifest

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/skills/types.ts:50`; `src/enterprise/client/features/admin/skills/controller.ts:227`
- **Problem:** The client-side import conversion API cannot carry the parsed package manifest, source version, or truncation acknowledgement. When `manifestText` is absent, `buildApplyImmediateVersionPayload` silently creates a minimal manifest with no network, Tool, or Skill dependencies.
- **Evidence:** The fallback is `buildMinimalSkillManifest(...)`, whose permissions and dependency arrays are all empty. Cross-layer verification found that `parseImportSource` returns content/resources but no executable enterprise manifest, and the injected admin data source calls this helper without `manifestText`, forces version `1.0.0`, and does not act on `resourcesTruncated`.
- **Impact / failure scenario:** Importing a ZIP whose manifest declares required permissions/dependencies publishes an org Skill with `filesystem: 'none'`, empty Tool/Skill dependencies, and potentially omitted resources. The import appears successful but behaves differently from the source package or fails when it references missing files.
- **Recommendation:** Define a typed parse-result-to-enterprise-manifest conversion, preserve compatible version/permission metadata, and require explicit confirmation or rejection when `resourcesTruncated` is true. Add end-to-end parse → applyImmediate tests covering manifest permissions, source version, dependencies, and truncated resources.

#### \[MEDIUM] Retained cursor pages permit duplicate Next transitions

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/skills/useCursorPagedList.tsx:52`; `src/enterprise/client/features/admin/skills/useCursorPagedList.tsx:125`; `src/enterprise/client/features/admin/skills/SkillListPage.tsx:304`
- **Problem:** Cursor hooks retain the prior page during a key transition, but pagination buttons remain enabled while the new page is loading. `goNext` blindly appends the supplied cursor, including when it already equals the active cursor.
- **Evidence:** `setCursorStack((current) => [...current, nextCursor])` has no duplicate/in-flight guard. The pager disables Next only for `!data.nextCursor || error`, while the table similarly derives `hasNext` from retained `data` and passes `loading={isLoading && !data}`.
- **Impact / failure scenario:** Double-clicking Next while page 2 is loading appends the page-2 cursor twice. The active SWR key does not change on the second append, but one Previous click still leaves the same cursor active, making Previous appear broken and corrupting the navigation history.
- **Recommendation:** Disable both cursor controls while the current cursor request is in flight, and make `goNext` idempotent when `nextCursor === current.at(-1)`. Add rapid-double-click regression tests for the table and shared detail pager.

#### \[MEDIUM] Integration test blesses a published catalog that readiness rejects

- **Dimension:** 2 / Test rot
- **Location:** `apps/server/src/enterprise/services/skillCatalog/adminService.test.ts:100`; `apps/server/src/enterprise/services/skillCatalog/readService.test.ts:639`
- **Problem:** The main admin-service integration test calls an opaque-content version an “exact server-only runtime projection” and asserts publication succeeds, but never exercises runtime readiness. Another in-scope test correctly establishes that the same projection is execution-incomplete and unavailable.
- **Evidence:** The helper sets `contentRef: 'opaque:skill-content-1'`; the test expects `validation.issues` to be empty and `service.publish(...)` to succeed. Conversely, `reports a stored but execution-incomplete projection as unavailable` expects an opaque projection to report `health: 'unavailable'`.
- **Impact / failure scenario:** CI remains green while a supported admin workflow publishes a revision that prevents managed-agent execution. The test’s title and assertions encode mutually incompatible publication and runtime contracts.
- **Recommendation:** Fix the valuable integration test: require publication to reject the opaque payload, or install the intended materializer and assert readiness plus runtime snapshot creation. Keep a separate repository-level test for detecting corrupted legacy rows.

#### \[MEDIUM] Raw English server messages cross the i18n boundary

- **Dimension:** 4 / Missing simplified-Chinese i18n
- **Location:** `apps/server/src/enterprise/services/skillCatalog/adminService.ts:535`; `apps/server/src/enterprise/services/skillCatalog/adminService.ts:561`; `src/enterprise/client/features/admin/skills/VersionsSection.tsx:259`
- **Problem:** The API returns hardcoded English `publishError` text and arbitrary `error.message` values, while version detail directly renders English validator messages under “technical details.” These bypass the complete zh-CN translations already present for validation codes.
- **Evidence:** Examples include `'A skill version is required before publish'`, `error.message.slice(0, 500)`, and `<Text>{issue.message}</Text>`. The Chinese locale contains translated `skillCatalog.validation.issue.*` keys, but the raw message remains visible.
- **Impact / failure scenario:** A zh-CN administrator sees English publication errors or technical validation prose. Unknown errors can also expose implementation-oriented backend wording rather than stable localized guidance.
- **Recommendation:** Return stable error/issue codes plus bounded structured details, then render them through `t()`. If raw diagnostics must remain available, label them explicitly as untranslated diagnostics and keep them separate from the user-facing error.

#### \[LOW] Several verified dead paths and hollow helpers remain

- **Dimension:** 3 / Dead code and dev cruft
- **Location:** `src/enterprise/client/features/admin/skills/openCreateSkillModal.tsx:58`; `src/enterprise/client/features/admin/skills/writeOperation.ts:27`; `apps/server/src/enterprise/services/skillCatalog/readService.ts:140`; `src/enterprise/client/features/admin/skills/useCursorPagedList.tsx:42`
- **Problem:** Four behavior/API fragments have no effective production consumer: the `withVersionPayload` modal mode has no caller; `rollbackableSkillVersions` is used only by its test while the component duplicates the predicate; `publishedExecutionRevision` controls a conditional whose branches are identical; and the cursor stack’s returned `reset` callback is never called.
- **Evidence:** Repo-wide searches found `withVersionPayload` only in its defining file, `rollbackableSkillVersions` only in its source/test, and no `.reset()` consumer. `isPublishedCatalogExecutionReady` returns `readinessByRevision.get(...) ?? false` on both sides of its `publishedExecutionRevision` check.
- **Impact / failure scenario:** Tests and comments imply supported behavior that no rendered/admin path uses, increasing maintenance cost and masking drift such as the disconnected create-with-version UI.
- **Recommendation:** Remove the unused modal mode and reset API unless they are wired into a real flow; either use `rollbackableSkillVersions` in `VersionsSection` or delete it and its test; remove the ineffective revision field/conditional.

#### \[LOW] Create modal mixes eleven state variables with mutation orchestration

- **Dimension:** 1 / Code smells
- **Location:** `src/enterprise/client/features/admin/skills/openCreateSkillModal.tsx:87`
- **Problem:** `CreateSkillContent` owns eleven independent `useState` values, two form modes, validation, reauthentication, API lifecycle, error mapping, and rendering in one component.
- **Evidence:** Lines 91–102 declare state for identity fields, policy flags, version content, loading, and errors; `submit` then conditionally builds two different payload shapes and runs the mutation.
- **Impact / failure scenario:** Mode-specific fields and validation can drift independently—the unused `withVersionPayload` mode is already evidence of that drift—and future changes require coordinating many separate setters.
- **Recommendation:** Extract a typed `useCreateSkillForm` reducer/hook, and split identity-only creation from create-and-publish version collection. Delete the second mode if no product flow owns it.

#### \[LOW] Read-service test file exceeds the repository size guideline

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/services/skillCatalog/readService.test.ts:1`
- **Problem:** The file is 838 lines, exceeding the repository’s approximately 800-line split threshold and combining catalog projection, cache, observability, concurrency, readiness, and historical runtime resolution tests.
- **Evidence:** `wc -l` reports 838 lines, the largest file in the partition.
- **Impact / failure scenario:** Shared setup and many unrelated scenarios make contract contradictions harder to notice and increase the cost of isolating failures.
- **Recommendation:** Split into focused suites such as projection/merge, cache/invalidation, runtime-readiness/reporting, and historical pinned-resolution tests while retaining shared fixture helpers.

### Metrics

- Total findings: 8 (CRITICAL 0, HIGH 1, MEDIUM 4, LOW 3)
- Largest in-scope files (lines): `readService.test.ts` 838, `adminService.ts` 665, `validator.ts` 612
- Dead-code candidates verified unused repo-wide: 4
