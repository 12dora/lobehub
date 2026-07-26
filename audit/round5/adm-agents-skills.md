# Round 5 Audit — adm-agents-skills

## Scope

Audited the fork delta under:

- `src/enterprise/client/features/admin/agents`
- `src/enterprise/client/features/admin/skills`
- `src/enterprise/client/features/skills`
- The assigned admin-agent/admin-skill/platform-skill services and tests
- `src/features/SkillStore`

The delta contains 106 files: 101 fork-added files and five modified upstream seams, totaling 19,193 additions and 21 deletions (19,214 changed LOC, net +19,172). Byte-identical upstream files under `src/features/SkillStore` were excluded. Commit `d84ca6758a` was the only listed Round-4 remediation commit touching this scope and was reviewed as a prime suspect.

## Summary

| Dimension                                             | Findings | Highest severity |
| ----------------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                        |        2 | MEDIUM           |
| D2 Test decay                                         |        2 | MEDIUM           |
| D3 Dead code and development debris                   |        1 | LOW              |
| D4 Missing Simplified Chinese i18n coverage           |        0 | —                |
| D5 Potential functional bugs                          |        1 | MEDIUM           |
| D6 Warnings and errors not surfaced via toast         |        3 | MEDIUM           |
| D7 Overly technical/internal-state-leaking UI strings |        2 | MEDIUM           |
| D8 Missing animations/motion                          |        1 | LOW              |

## Findings

### adm-agents-skills-D1-1 — Agent detail loading and polling fan out into dozens of sequential requests

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `src/enterprise/client/features/admin/agents/useAdminAgents.ts:37-76`, `src/enterprise/client/features/admin/agents/useAdminAgents.ts:107-147`, `src/enterprise/client/features/admin/agents/useAdminAgents.ts:161-183`, `src/enterprise/client/features/admin/agents/useAdminAgents.ts:323-331`
- **Confidence:** HIGH
- **What:** Opening one Agent detail drains as many as 20 pages each for assignments, rollouts, and versions. Active rollout polling repeats another page drain every two seconds.
- **Evidence:** `fetchAdminAgentDetail` launches three `collectPages` calls with `limit: 100`; each call follows cursors sequentially until `ADMIN_AGENT_COLLECTION_PAGE_LIMIT = 20`. A maximal detail load therefore issues 61 requests and waits for up to 20 serial network round trips on its critical path. `fetchActiveAdminAgentRollouts` uses the same drain and is configured with `refreshInterval: 2000`.
- **Impact:** Large enterprise catalogs can make the detail screen slow to open and can generate up to 20 rollout-list requests every two seconds per open browser tab. The manual “Load more” UI added by Round 4 does not prevent the initial eager drain.
- **Fix:** Fetch only the first page of each collection during detail loading and paginate assignments, versions, and rollouts independently. For polling, add a server batch-status endpoint for the known job IDs or return active rollout summaries in a single bounded request.

### adm-agents-skills-D1-2 — Skill recovery serializes and scans megabyte-sized drafts on every keystroke

- **Severity:** MEDIUM
- **Dimension:** D1 Code smells
- **Location:** `src/enterprise/client/features/admin/skills/hooks/useSkillEditor.ts:163-190`, `src/enterprise/client/features/admin/skills/localDraftStorage.ts:12-16`, `src/enterprise/client/features/admin/skills/localDraftStorage.ts:111-174`, `src/enterprise/client/features/admin/skills/openVersionEditorModal.tsx:62-69`
- **Confidence:** HIGH
- **What:** Every dirty draft state change synchronously persists the entire recovery snapshot to `localStorage`.
- **Evidence:** The editor effect invokes `saveSkillLocalDraft` directly whenever `draft` changes. Version-editor fields call `onDraftChange` on every edit. A single save can process up to 1.9 MB, stringify twice, perform repeated UTF-8 byte encoding, normalize both base and current drafts, scan up to 10,000 nodes for secrets, and call synchronous `localStorage.setItem`.
- **Impact:** Editing large `SKILL.md`, manifest, or resource payloads can block the browser main thread on every keystroke, causing input lag and dropped frames.
- **Fix:** Mirror `useAdminAgentDraftPersistence`: debounce trailing writes, preserve page-hide/unmount flushing, and move expensive normalization/secret scanning out of the immediate input event path.

### adm-agents-skills-D2-1 — Round-4 collection pagination has no failure-path regression coverage

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/enterprise/client/features/admin/agents/AgentDetailView.tsx:123-231`, `src/enterprise/client/features/admin/agents/AssignmentPanel.tsx:87-100`, `src/enterprise/client/features/admin/agents/RolloutPanel.tsx:197-217`
- **Confidence:** HIGH
- **What:** The Round-4 “Load more” paths are untested despite introducing network, cursor, deduplication, loading, and rejection behavior.
- **Evidence:** Repo-wide searches across `AgentDetailView.test.tsx`, `AssignmentPanel.test.tsx`, and `RolloutPanel.test.tsx` found no `loadMore`, `onLoadMore`, `truncated`, or `collectionMeta` coverage. Consequently, the unhandled rejection documented in D6-1 passes the suite.
- **Impact:** Cursor regressions, duplicate pages, missing loading feedback, and rejected requests can recur without a failing test.
- **Fix:** Add component tests for successful pagination, repeated-click protection, cursor advancement, deduplication, end-of-list behavior, and request/mutate rejection with retry feedback.

### adm-agents-skills-D2-2 — None of the five modified SkillStore admin seams has a component test

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/features/SkillStore/SkillList/Community/MarketSkillItem.tsx:51-99`, `src/features/SkillStore/SkillList/ImportFromGithubModal.tsx:14-49`, `src/features/SkillStore/SkillList/ImportFromUrlModal.tsx:14-48`, `src/features/SkillStore/SkillList/UploadSkillModal.tsx:17-70`, `src/features/SkillStore/index.tsx:8-25`
- **Confidence:** HIGH
- **What:** Fork-specific org-catalog routing, permission behavior, modal feedback, and provider propagation were added without tests.
- **Evidence:** A repo-wide test/spec search found no references to `MarketSkillItem`, `ImportFromGithubModal`, `ImportFromUrlModal`, `UploadSkillModal`, or their modal-opening functions.
- **Impact:** The wrong permission gating and contradictory import feedback in D5-1 and D6-2 were able to ship unchecked. A provider regression could also silently route an admin operation back to a personal skill store.
- **Fix:** Render each seam both with and without `AdminToolScope`; assert the selected datasource, platform RBAC-disabled states, success/soft-failure/error feedback, modal close behavior, and scope propagation through `createSkillStoreModal`.

### adm-agents-skills-D5-1 — Admin SkillStore actions are gated by personal permissions instead of platform RBAC

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/features/SkillStore/SkillList/Community/MarketSkillItem.tsx:48-60`, `src/features/SkillStore/SkillList/Community/MarketSkillItem.tsx:66-99`, `src/features/SkillStore/SkillList/Community/MarketSkillItem.tsx:134-155`, `src/features/SkillStore/SkillList/ImportFromGithubModal.tsx:19-47`, `src/features/SkillStore/SkillList/ImportFromUrlModal.tsx:18-46`, `src/features/SkillStore/SkillList/UploadSkillModal.tsx:22-44`
- **Confidence:** HIGH
- **What:** Once an admin scope is present, mutations target the organization catalog, but enabled/disabled state still comes from personal `create_content` and `edit_own_content` permissions.
- **Evidence:** `MarketSkillItem` branches to `adminScope.installFromMarket` and `adminScope.deleteOrgSkill` while `canCreate` and `canEdit` still come from `usePermission`. All three import override modals likewise check only the personal `canCreate`. The admin scope already exposes `capabilities.canCreateSkill` and `capabilities.canDeleteSkill`, but these are not consulted.
- **Impact:** Read-only or partially privileged administrators see enabled organization-wide mutation controls and only discover the denial after submitting. Conversely, a future restrictive personal permission could incorrectly hide an organization action the administrator is authorized to perform. Server authorization still prevents privilege escalation.
- **Fix:** In admin scope, derive install/import/delete affordances from `adminScope.capabilities.canCreateSkill` and `canDeleteSkill`; use personal permissions only when no admin scope exists. Pass the resolved capability into the three modal options so their fields and submit controls match platform RBAC.

### adm-agents-skills-D6-1 — “Load more” failures reject silently and leave no retry feedback

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `src/enterprise/client/features/admin/agents/AgentDetailView.tsx:123-231`, `src/enterprise/client/features/admin/agents/AgentDetailView.tsx:370-383`, `src/enterprise/client/features/admin/agents/AssignmentPanel.tsx:87-100`, `src/enterprise/client/features/admin/agents/RolloutPanel.tsx:197-217`
- **Confidence:** HIGH
- **What:** The three collection pagination paths have no error handler. Version and assignment buttons also have no pending state.
- **Evidence:** `loadMoreCollection` directly awaits service calls and SWR mutation without `try/catch`. Callers discard the returned promise with `void`. Rollouts use `.finally(...)`, which clears loading but does not catch the rejection; assignments and versions do not even set loading.
- **Impact:** A failed request appears to do nothing, leaves the truncation warning unchanged, allows duplicate clicks, and can produce an unhandled promise rejection. Administrators receive no explanation or actionable retry state.
- **Fix:** Track pending/error state per collection, disable or set `Button loading` while fetching, catch failures, retain the cursor, and emit `toast.error(t('agentCatalog.collection.loadFailed'))` from `@lobehub/ui/base-ui`. Keep an inline Retry action in the warning.

### adm-agents-skills-D6-2 — Admin imports emit duplicate and sometimes contradictory outcome messages

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `src/features/SkillStore/SkillList/ImportFromGithubModal.tsx:40-46`, `src/features/SkillStore/SkillList/ImportFromUrlModal.tsx:39-45`, `src/features/SkillStore/SkillList/UploadSkillModal.tsx:40-46`
- **Confidence:** HIGH
- **What:** Every override callback is followed by a generic success message and modal close, although the actual admin callback already reports whether the import was published or only saved as a draft.
- **Evidence:** The three modals unconditionally call `message.success(agentSkillModal.importSuccess)` after their `Promise<void>` override resolves. Caller verification found that the admin provider emits its own success when `published` is true and a warning when publication soft-fails. A soft failure therefore produces “saved as draft/publish pending,” immediately followed by “imported successfully,” then closes the modal.
- **Impact:** Administrators can believe a Skill is available organization-wide when it only exists as an unpublished draft. Even successful imports produce duplicate success notifications.
- **Fix:** Give override callbacks a typed outcome such as `{ published: boolean; publishError?: string }` or designate the provider as the sole owner of feedback. In override mode, do not emit the modal’s generic success toast; close only after the provider has reported the authoritative outcome.

### adm-agents-skills-D6-3 — Refresh retry replays one-shot success callbacks and toasts

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `src/enterprise/client/features/admin/skills/hooks/useSkillActions.tsx:97-156`, `src/enterprise/client/features/admin/skills/hooks/useSkillActions.tsx:188-195`, `src/enterprise/client/features/admin/skills/hooks/useSkillActions.tsx:237-244`, `src/enterprise/client/features/admin/skills/hooks/useSkillActions.tsx:290-306`, `src/enterprise/client/features/admin/skills/hooks/useSkillActions.tsx:360-370`
- **Confidence:** HIGH
- **What:** Round 4 combined retryable recovery work and one-shot UI effects into the same `recover` closure.
- **Evidence:** `recover` reruns `params.onCommitted` before verification, and `retryRefresh` invokes that same closure on every retry. Callers use `onCommitted` for `markSaved`, `markVersionSaved`, validation state changes, and success/warning toasts. The existing retry tests mock toast anonymously and never assert its call count.
- **Impact:** Every failed refresh retry can announce another successful save/validation/publication even though freshness verification still fails. Repeated retries create noisy and misleading feedback.
- **Fix:** Split the callback into one-shot `onCommit` work and idempotent retryable `recover/verify` work. Run state finalization and success toasts exactly once after the server commit; only cache invalidation and verification should be retried.

### adm-agents-skills-D7-1 — Enterprise import errors are rendered verbatim to administrators

- **Severity:** MEDIUM
- **Dimension:** D7 Overly technical/internal-state-leaking UI strings
- **Location:** `src/features/SkillStore/SkillList/ImportFromGithubModal.tsx:40-45`, `src/features/SkillStore/SkillList/ImportFromGithubModal.tsx:74`, `src/features/SkillStore/SkillList/ImportFromUrlModal.tsx:39-44`, `src/features/SkillStore/SkillList/ImportFromUrlModal.tsx:71`, `src/features/SkillStore/SkillList/UploadSkillModal.tsx:65-66`, `src/features/SkillStore/SkillList/UploadSkillModal.tsx:93`, `src/enterprise/client/services/adminSkills.ts:34-35`, `src/enterprise/client/services/adminSkills.ts:74-77`
- **Confidence:** HIGH
- **What:** New enterprise override failures are copied from `err.message` into an alert through the template `Import failed: {{error}}`.
- **Evidence:** All three modals use `catch (err: any) { setError(err?.message || String(err)); }`. Admin parsing and mutation services rethrow failures after their toast/error wrapper, allowing router messages, internal codes, or backend details to reach the alert unchanged.
- **Impact:** Users can see duplicate error feedback and potentially unactionable HTTP, validation, service, or persistence details.
- **Fix:** Map known errors to safe localized guidance and log/reference technical details separately. Exact replacement:

  - **en-US:** “We couldn’t import this Skill. Check the source and try again.”
  - **zh-CN:** “无法导入此技能。请检查来源后重试。”

### adm-agents-skills-D3-1 — Dead presentation wrappers and an unused Round-4 variable remain in production

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `src/enterprise/client/features/skills/presentation.ts:1-16`, `src/enterprise/client/features/skills/presentation.test.ts:1-25`, `src/enterprise/client/features/skills/index.ts:1`, `src/enterprise/client/features/admin/agents/AgentDetailView.tsx:133-138`
- **Confidence:** HIGH
- **What:** The published-skill presentation module only forwards to existing helpers and has no production caller; its test is its only consumer. Separately, Round 4 computes `truncKey` but never reads it.
- **Evidence:** Repo-wide searches found `isPublishedSkillEnabled` and `getPublishedSkillToggleMode` only in `presentation.ts` and its test. The barrel re-exports the dead module. `truncKey` has exactly one repository occurrence: its declaration.
- **Impact:** The wrapper tests duplicate lower-level policy coverage and imply a live presentation boundary that does not exist. The unused variable is leftover pagination scaffolding and should be rejected by a full lint/type pass.
- **Fix:** Remove the unused wrapper module/test/export unless a real consumer is intended, and remove `truncKey`.

### adm-agents-skills-D7-2 — Conflict resolution exposes raw field names and enum/boolean values

- **Severity:** LOW
- **Dimension:** D7 Overly technical/internal-state-leaking UI strings
- **Location:** `src/enterprise/client/features/admin/skills/SkillEditorBanners.tsx:76-101`
- **Confidence:** HIGH
- **What:** The rebase-conflict UI renders internal property names and `String()` conversions rather than localized labels and values.
- **Evidence:** It prints `item.field` directly and interpolates `String(item.latest)` and `String(item.local)`. Administrators therefore see values such as `displayName`, `distribution`, `true`, `false`, `mandatory`, and `optional`.
- **Impact:** The UI exposes implementation terminology at the point where users must make a consequential conflict choice.
- **Fix:** Map fields and values to localized copy:

  - **en-US fields:** “Display name”, “Description”, “Availability policy”, “Enabled”
  - **zh-CN fields:** “显示名称”, “描述”, “可用范围”, “是否启用”
  - **en-US values:** “Enabled”, “Disabled”, “Enabled by default”, “Required for everyone”, “Available when selected”
  - **zh-CN values:** “已启用”, “已停用”, “默认启用”, “所有人必须启用”, “按需选择”

### adm-agents-skills-D8-1 — Paginated and polled Agent rows appear abruptly

- **Severity:** LOW
- **Dimension:** D8 Missing animations/motion
- **Location:** `src/enterprise/client/features/admin/agents/AgentDetailView.tsx:388-422`, `src/enterprise/client/features/admin/agents/AssignmentPanel.tsx:219-270`, `src/enterprise/client/features/admin/agents/RolloutPanel.tsx:243-295`
- **Confidence:** MEDIUM
- **What:** Versions, assignments, and rollouts are rendered through direct array maps without enter or status-transition motion.
- **Evidence:** Load-more appends rows directly, and polling can add or update rollout rows every two seconds. No animation or transition declaration exists on these row containers, so content and status changes pop into place.
- **Impact:** Large row insertions and live rollout updates create visible layout jumps and make it harder to recognize what changed.
- **Fix:** Apply a row class to the existing `@lobehub/ui` `Block` components using `createStaticStyles`; animate new rows with a short opacity/translate keyframe using `cssVar.motionDurationMid` and `cssVar.motionEaseOut`, and transition status/background changes with the same tokens. Disable the animation under `@media (prefers-reduced-motion: reduce)`. No new animation dependency is needed.

## Dimensions with no findings

- **D4 Missing Simplified Chinese i18n coverage:** Literal and dynamic translation-key families used by the fork-owned Agent and Skill admin surfaces were checked against `packages/locales/src/default`, `locales/en-US`, and `locales/zh-CN`. No missing, empty, mistyped, or clearly untranslated zh-CN key was verified; the language-neutral “URL” labels were not treated as untranslated copy.

## Cross-scope notes

- `src/routes/(main)/settings/skill/features/LeftPanel.tsx:84-125` wires the three in-scope modal overrides without passing platform capabilities, while `src/enterprise/client/features/admin/ai/toolScope/useAdminGlobalToolScope.tsx:346-360` and `433-468` already own authoritative outcome feedback. Those callers should be updated together with D5-1 and D6-2 so the contract has one permission source and one feedback owner.
