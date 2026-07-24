# Partition: skills

## Summary

Authorization and publication CAS controls are generally sound, but the partition has three high-impact defects involving secret retention, resource canonicalization, and built-in suppression, plus several bounded workflow defects. CRITICAL: 0 · HIGH: 3 · MEDIUM: 4 · LOW: 2.

## Findings

### F1 \[HIGH]\[D5] Secret-bearing versions are permanently persisted despite validation failure

- **Location:** `apps/server/src/enterprise/services/skillCatalog/validator.ts:536`, `apps/server/src/enterprise/services/skillCatalog/adminService.ts:455`, `apps/server/src/enterprise/services/skillCatalog/adminService.ts:465`, `apps/server/src/enterprise/routers/admin/skills.ts:204`
- **Evidence:** The validator emits `secret_material_detected`, but `createVersion` unconditionally proceeds to `this.model(tx).createVersion(...)` and stores that validation result. `getVersion` subsequently returns the complete content and resources to any caller with `SKILL_READ`.
- **Impact / failure scenario:** An updater imports or submits content containing an API key. Publication is blocked, but the immutable version—including the credential—remains in PostgreSQL, backups, and admin reads. A different read-only administrator can retrieve it, and there is no version deletion path.
- **Fix:** Before inserting a version, treat any error-level `secret_material_detected` issue as non-persistable and throw `SkillCatalogValidationError`. Add a regression asserting that no version row or draft-sequence change occurs.
- **Confidence:** HIGH

### F2 \[HIGH]\[D5] Resource canonicalization corrupts size metadata and can disable the entire managed catalog

- **Location:** `packages/database/src/models/platform/skillCanonicalize.ts:252`, `packages/database/src/models/platform/skillCatalog.model.ts:124`, `apps/server/src/enterprise/services/skillCatalog/validator.ts:498`, `apps/server/src/enterprise/services/skillCatalog/validator.ts:523`, `apps/server/src/enterprise/services/skillCatalog/readService.ts:237`
- **Evidence:** `canonicalizePlatformSkillResources` spreads each resource, changes `content` to NFC/LF form, but retains the original `sizeBytes` and `checksum`. Publication validation checks canonical text and inline presence, but never rechecks UTF-8 byte length against `sizeBytes`. The read service later strictly parses the stored resources while building the catalog.
- **Impact / failure scenario:** A valid input resource `{content: "B\\r\\n", sizeBytes: 3}` passes the input contract. Persistence changes it to `"B\\n"` while leaving `sizeBytes: 3`; publication then succeeds, but catalog materialization rejects the inconsistent resource. One such published skill can make the complete managed-skill projection unavailable.
- **Fix:** Canonicalize resource content before calculating its metadata, or recompute `sizeBytes` and the content checksum from canonical bytes. Publication validation should independently verify both fields. Add an end-to-end CRLF/NFD resource regression through publish and catalog resolution.
- **Confidence:** HIGH

### F3 \[HIGH]\[D5] Archiving a built-in override can silently reactivate the bundled skill

- **Location:** `packages/database/src/models/platform/skillCatalog.pointer.ts:64`, `packages/database/src/models/platform/skillCanonicalize.ts:185`, `apps/server/src/enterprise/services/skillCatalog/readService.ts:222`
- **Evidence:** Archive payloads use `buildPublishedSnapshot(lockedDraft, ...)`, which copies the mutable draft’s `enabled` value, then merely add `builtinOverrideTombstone: true`. The catalog authority only recognizes enabled archived tombstones; `readService` removes bundled skills solely from the resulting tombstone list.
- **Impact / failure scenario:** A built-in override is published and suppressing the bundled skill. An administrator saves `enabled=false` as an unpublished identity draft and then archives it. The archive snapshot contains `enabled:false`, so its tombstone is omitted and the original bundled skill becomes active again—potentially reversing an organization-wide security decision.
- **Fix:** For archived built-in-override tombstones, force the snapshot’s tombstone eligibility independently of mutable `enabled`—for example, materialize the archived tombstone with `skill.enabled: true`. Add a regression covering an unpublished disabled draft archived over an active override.
- **Confidence:** HIGH

### F4 \[MEDIUM]\[D5] Explicit validation always strands the admin UI in “refresh failed”

- **Location:** `apps/server/src/enterprise/services/skillCatalog/adminService.ts:488`, `apps/server/src/enterprise/services/skillCatalog/validationService.ts:57`, `apps/server/src/enterprise/services/skillCatalog/validator.ts:631`, `src/enterprise/client/features/admin/skills/hooks/useSkillActions.tsx:282`
- **Evidence:** `validateStoredVersion` returns a newly timestamped result but never updates `validationResult`. The UI then calls `getVersion` and requires `JSON.stringify(version.validation) === JSON.stringify(result)`. The stored timestamp remains the creation-time value while each validation returns `validatedAt: new Date()`.
- **Impact / failure scenario:** Clicking Validate succeeds server-side, but verification fails. The UI sets `refreshFailed`, locks all write actions, and every retry compares against the same stale stored result. A formerly invalid version that is now valid cannot be published through the admin UI.
- **Fix:** Persist the fresh validation metadata in the same audited transaction before returning it. Add a server regression verifying `getVersion().validation`, and a hook test using different old/new validation timestamps.
- **Confidence:** HIGH

### F5 \[MEDIUM]\[D5] `applyImmediate` rejects after committing the draft update

- **Location:** `apps/server/src/enterprise/services/skillCatalog/adminService.ts:583`, `apps/server/src/enterprise/services/skillCatalog/adminService.ts:632`, `apps/server/src/enterprise/services/skillCatalog/adminService.ts:650`, `apps/server/src/enterprise/routers/admin/skills.test.ts:645`
- **Evidence:** Update mode commits `updateDraft` in its own transaction before publishing. For an already-published skill, `tryPublishImmediate` rethrows publication failure after rereading the committed draft. The existing regression asserts only that the request rejects; it does not check that `"Hard Fail Renamed"` was already saved.
- **Impact / failure scenario:** Validation policy changes or an invalid version ID causes publication to fail. The client receives a failed request and does not refresh, although identity/distribution/enabled changes are committed. Retrying from stale UI state can create conflicts or duplicate operator actions.
- **Fix:** Either make update-and-publish atomic, or return the existing `{published:false, publishError, draft}` partial-success contract for update failures. FIX the current test to assert the chosen state semantics.
- **Confidence:** HIGH

### F6 \[MEDIUM]\[D5] Never-published drafts cannot be archived or deleted

- **Location:** `apps/server/src/enterprise/services/skillCatalog/publication.ts:136`, `src/enterprise/client/features/admin/skills/useCreateSkillForm.ts:14`, `src/enterprise/client/features/admin/skills/SkillDetailActions.tsx:81`
- **Evidence:** The normal create flow intentionally creates identity only. The UI exposes Archive for every non-archived skill, but the server executes `if (!skill?.currentVersionId) throw new SkillCatalogNotFoundError()`. Drafts have no current version until first publication.
- **Impact / failure scenario:** An administrator creates an accidental or invalid draft and clicks Archive. It returns Not Found. A user with create/delete but no publish permission has no way to remove it; even a publisher must expose a valid version before it can be archived.
- **Fix:** Add a CAS-protected, audited cancellation path for never-published skills—deleting the shell and child draft versions atomically, or introducing a revision-zero archived state with enforced mutation rules. Add empty-shell and versioned-unpublished regressions.
- **Confidence:** HIGH

### F7 \[MEDIUM]\[D5] Extensionless ZIP URLs are truncated at the markdown limit

- **Location:** `apps/server/src/enterprise/routers/admin/skillsImportParse.ts:608`, `apps/server/src/enterprise/routers/admin/skillsImportParse.ts:615`, `apps/server/src/enterprise/routers/admin/skillsImportParse.ts:638`
- **Evidence:** Before response headers are available, `fetchMaxBytes` is chosen from URL path heuristics: non-`.zip` paths receive the 1 MiB content limit. Only after fetching does `Content-Type: application/zip` select ZIP parsing and the intended 20 MiB limit.
- **Impact / failure scenario:** A valid 2 MiB ZIP served from a signed or extensionless URL such as `/artifact/123` is capped or truncated at 1 MiB and reported as an invalid import, despite being below `MAX_IMPORT_ZIP_BYTES`.
- **Fix:** Fetch generic URLs with the bounded 20 MiB ZIP ceiling, then enforce the 1 MiB text limit after classifying headers/body. ADD a regression for an extensionless `application/zip` response larger than 1 MiB.
- **Confidence:** HIGH

### F8 \[LOW]\[D3] The built-in source filter has no production data source

- **Location:** `packages/database/src/models/platform/skillCatalog.model.ts:83`, `apps/server/src/enterprise/services/skillCatalog/adminService.ts:363`, `src/enterprise/client/features/admin/skills/SkillListPage.tsx:47`, `src/enterprise/client/features/admin/skills/SkillListPage.tsx:251`
- **Evidence:** Every production `createSkill` call hardcodes `source: 'uploaded'`, and the admin list delegates only to database rows. Nevertheless, the UI exposes `source=builtin`. Bundled definitions are merged only by the runtime read service, not the admin list.
- **Impact / failure scenario:** Selecting Built-in always produces an empty table, misleading administrators into believing no bundled skills exist.
- **Fix:** Remove the unsupported filter option, or merge read-only built-in definitions into the admin list with stable identifiers and explicit non-editable behavior.
- **Confidence:** HIGH

### F9 \[LOW]\[D2] `readService.test.ts` is an empty test artifact

- **Location:** `apps/server/src/enterprise/services/skillCatalog/readService.test.ts:1`
- **Evidence:** The `.test.ts` file contains only a comment listing other test files and `export {};`; it declares no suite and makes no assertions.
- **Impact / failure scenario:** It adds no coverage and can be selected by test discovery as an empty test file, creating noise or “no tests found” failures in targeted runs.
- **Fix:** DELETE the file; its explanatory list is unnecessary because the actual concern-specific test files are self-describing.
- **Confidence:** HIGH

## Dimension coverage

① Checked service/model size, CAS locking, publication transactions, parser limits, caching, and pagination; no standalone code-smell finding beyond defects classified under correctness.

② Found one empty test to DELETE (F9); critical regression gaps and the stale partial-commit assertion require ADD/FIX coverage in F1–F7.

③ Found one ineffective admin filter with no production producer (F8); no other confirmed dead exports, debug leftovers, or stale TODOs.

④ Clean: all 162 `skillCatalog.*` en-US keys exist in zh-CN, none retain the English value, and audited UI call sites use the `admin` namespace.

⑤ Issues cluster around secret persistence, canonical resource integrity, built-in tombstones, validation persistence, partial commits, draft deletion, and URL import classification (F1–F7).
