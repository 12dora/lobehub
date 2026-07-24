## Partition: settings-branding

Scope reviewed: Server settings/branding services and enterprise admin settings, general-settings, and branding clients.
Files examined: 70 TypeScript/TSX files, approximately 15,695 lines; contracts, database models, routers, registries, callers, and locales were also read for verification.

### Summary

The largest risk is that settings drafts are still treated as whole-table snapshots even though ownership is split between the policy editor and service-model administration. Ordinary policy-editor saves can also rewrite hidden service-model policies, so the client-side preservation workaround does not provide a reliable ownership boundary. Reauthentication is enforced server-side and both security registries are complete, but the normal publish flow loses auth-method context. Branding and general settings are otherwise reasonably structured, although failure isolation, unsaved-change handling, cache bounds, and regression coverage need attention.

### Findings

#### \[HIGH] Settings save and publish remain unscoped whole-table replacements

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/settings/adminSettingsService.ts:142`, `apps/server/src/enterprise/services/settings/adminSettingsService.ts:334`, `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:575`
- **Problem:** The server accepts a client-supplied draft as the complete global settings bundle, and publishing materializes it without restricting changes or deletions to paths owned by the policy editor. Ownership exists only as a client-side convention.
- **Evidence:** Publishing calls `model.replacePublishedPolicies({ draft: policies, ... })`, while saving uses `model.saveDraft({ draft: params.draft, ... })`. The shared database model deletes all `platform_setting_policies` rows when the supplied draft is empty, or every row absent from a non-empty draft. The client comment explicitly acknowledges that an empty publish would wipe service-model assignments.
- **Impact / failure scenario:** A stale, older, scripted, or malicious client with settings update/publish permission submits `{}` or a partial policy-editor draft. Validation succeeds, saving replaces the shared draft, and publishing deletes service-model/system-agent/image policies belonging to another administration surface.
- **Recommendation:** Define the policy editor’s owned paths on the server. Merge owned-path changes into the authoritative draft and delete only owned published paths; preserve all foreign paths during save, publish, and rollback. Never rely on the UI to carry foreign rows forward.

#### \[HIGH] Saving a visible setting rewrites hidden service-model policies

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:396`, `src/enterprise/client/features/admin/settings/settingsPolicyController.ts:59`, `apps/server/src/enterprise/services/settings/adminSettingsService.ts:472`
- **Problem:** Hidden service-model rows remain in the editor draft, and every row is normalized during any save. This changes policies the administrator cannot see or review.
- **Evidence:** `normalizeSettingsPolicyDraft(draft)` maps every non-`user` row to `{ mode: 'locked', visibility: 'hidden' }`. In contrast, `applyImmediate` intentionally writes service-model values as `mode: 'default'` and normally preserves `visibility: 'visible'`. Those rows are filtered only from rendering and change preview.
- **Impact / failure scenario:** Service-model administration publishes a visible default model assignment. An administrator later changes only `general.fontSize` in the settings editor. Saving silently converts the hidden model assignment to locked/hidden; publishing then forces the model and removes user control without showing it in the preview.
- **Recommendation:** Normalize only paths owned and rendered by the policy editor. Preserve hidden/foreign entries byte-for-byte, and enforce the same ownership rule server-side.

#### \[MEDIUM] Ownership regressions are tested only through client mocks

- **Dimension:** 2 / Test rot
- **Location:** `src/enterprise/client/features/admin/settings/SettingsPolicyPage.test.tsx:433`, `apps/server/src/enterprise/services/settings/adminSettingsService.test.ts:325`
- **Problem:** The prior cross-owner deletion failure has no backend regression test. The client test merely inspects the draft passed to a mocked service, while the server publish test seeds only settings owned by that test.
- **Evidence:** The test named `restore-defaults preserves service-model published paths` asserts `mocks.saveDraft.mock.calls[0]`, never executing database materialization. No server test seeds a foreign service-model row and then publishes an empty or partial policy-editor draft.
- **Impact / failure scenario:** Whole-table deletion or hidden-row mutation can recur while all current tests remain green.
- **Recommendation:** Add named integration regressions: `empty policy-editor publish preserves foreign service-model rows`, `partial save preserves foreign draft paths`, and `saving a visible setting leaves hidden default/visible policies byte-identical`. Keep the client payload test, but do not treat it as the ownership invariant.

#### \[MEDIUM] Post-commit refresh failures are reported as failed mutations

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:399`, `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:529`, `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:632`
- **Problem:** Save or publish and subsequent SWR refreshes share one `try/catch`, so a refresh failure is handled as though the server mutation failed.
- **Evidence:** After `adminSettingsService.saveDraft()` or `.publish()` succeeds, the code executes `await mutate()` inside the same guarded block. Any rejection reaches the mutation failure handler; publish rethrows it to the reason modal.
- **Impact / failure scenario:** Publishing commits revision 12, but the follow-up fetch loses connectivity. The modal reports failure and remains retryable. Retrying with the captured revision/token then produces a conflict because revision 12 already exists.
- **Recommendation:** Separate commit and refresh phases. Once the mutation succeeds, report success; use `Promise.allSettled` or a dedicated refresh error state and offer a refresh retry without repeating the mutation.

#### \[MEDIUM] General settings discard edits without an unsaved-changes guard

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/generalSettings/GeneralSettingsPage.tsx:81`
- **Problem:** The page tracks a local draft and computes `dirty`, but never registers the shared SPA navigation or `beforeunload` guard.
- **Evidence:** Lines 81–101 create the draft and dirty comparison; unlike the settings-policy and branding pages, the file contains no `useUnsavedChangesGuard` call.
- **Impact / failure scenario:** An administrator changes registration or allowlist settings, then switches unified-admin tabs, follows another route, or reloads the page. The component unmounts and silently loses the changes.
- **Recommendation:** Register the shared unsaved-changes guard whenever `dirty` is true, with localized leave/stay copy. Add route-navigation, embedded-tab, and browser-unload tests.

#### \[MEDIUM] Branding failure prevents the closed-registration setting from being read

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/services/branding/resolvePublicSnapshot.ts:34`, `apps/server/src/enterprise/services/branding/resolvePublicSnapshot.test.ts:96`
- **Problem:** Branding and authentication reads share one sequential `try/catch`. If branding resolution fails, the authentication read is skipped and the fallback snapshot defaults registration to open.
- **Evidence:** `getPublishedBranding(db)` runs before `getAuthSettings(db)`, and the catch returns `buildPlatformPublicSnapshot({ flags })`. The existing branding-error test codifies the all-or-nothing fallback rather than asserting that authentication still resolves.
- **Impact / failure scenario:** Registration is closed, but an invalid or unavailable published-branding row throws. The anonymous snapshot reports `openRegistration: true`, so the login page displays a signup path that platform policy has disabled.
- **Recommendation:** Isolate the two reads with independent error handling or `Promise.allSettled`. Preserve successfully loaded authentication policy when branding fails. Fix the current test and add `branding failure + openRegistration=false remains false`.

#### \[MEDIUM] Effective-settings cache grows without a bound

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:52`, `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:180`, `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:231`
- **Problem:** The module-global cache has a TTL check but no eviction of expired or superseded entries.
- **Evidence:** `softCache` is an unrestricted `Map`; expired entries are ignored but not deleted, and every user/platform/override revision creates another key. `dropUserCache` runs only for a user mutation.
- **Impact / failure scenario:** A long-running instance serves many read-only users or platform revisions. Every unique cache key remains resident indefinitely, causing memory consumption to grow with historical traffic rather than active traffic.
- **Recommendation:** Replace it with the bounded domain cache used by branding, or implement size-limited LRU plus expired-entry deletion/sweeping. Add a stress test asserting bounded size across many users and revisions.

#### \[LOW] Normal settings publish drops trusted auth-method context

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:516`, `src/enterprise/client/features/admin/settings/SettingsPolicyPage.test.tsx:79`
- **Problem:** The normal publish reason modal does not receive `authMethod`, even though the hook has it and publish requires recent reauthentication.
- **Evidence:** `openReasonModal({ buildPayload, ... })` omits `authMethod`; branding publish passes it, and reset-defaults passes it to `withAdminReauthRetry`. The settings test replaces the retry helper with a direct call and never asserts the modal’s auth method.
- **Impact / failure scenario:** A stale API-key admin session attempts publish. Without the trusted `api-key` method, the client opens an unusable interactive sign-in popup rather than immediately presenting the supported “cannot reauthenticate” path. Server enforcement still prevents a bypass.
- **Recommendation:** Pass `authMethod` to the publish modal. Add a regression asserting that publish/reset carry auth context while `saveDraft` remains a direct, non-reauthenticated mutation.

#### \[LOW] Verified unused compatibility helpers and branding editor remnants remain

- **Dimension:** 3 / Dead code & dev cruft
- **Location:** `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:522`, `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:534`, `apps/server/src/enterprise/services/settings/effectiveSettingsService.ts:560`, `apps/server/src/enterprise/services/settings/pathUtils.ts:16`, `apps/server/src/enterprise/services/settings/pathUtils.ts:71`, `src/enterprise/client/features/admin/branding/navigationDecision.ts:4`, `src/enterprise/client/features/admin/branding/store.ts:24`
- **Problem:** Seven helpers/actions have no repository-wide production callers: `adaptLegacyUpdateSettings`, `loadPublishedPolicyMap`, `readEffectivePath`, `isValidSettingPathShape`, `deleteByPath`, `createBrandingNavigationDecision`, and branding-store `replaceDraft`.
- **Evidence:** Repository-wide searches found only definitions, barrel exports, or dedicated tests. The branding navigation alias merely re-exports the shared primitive and is consumed only by its own duplicate test.
- **Impact / failure scenario:** These APIs enlarge the maintenance and test surface, preserve a deprecated adapter, and make it unclear which settings/branding interfaces are actually supported.
- **Recommendation:** Remove the unused exports, implementations, and tests. If any are intentionally external APIs, document and contract-test that external use instead of leaving “tests/tooling” comments without callers.

#### \[LOW] Settings service test file exceeds the repository size guideline

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/services/settings/adminSettingsService.test.ts:1`
- **Problem:** The file is 909 lines, exceeding the repository’s approximately 800-line single-file guideline.
- **Evidence:** It combines draft validation, publication, rollback, audit, concurrency, AI-reference validation, and `applyImmediate` behavior in one file.
- **Impact / failure scenario:** Ownership and publication regressions become harder to locate and extend, encouraging additional broad fixtures instead of focused invariant tests.
- **Recommendation:** Split it into focused suites such as draft/publish ownership, publication/rollback, AI-reference validation, and `applyImmediate`.

#### \[LOW] Settings editor hook has too many coupled responsibilities

- **Dimension:** 1 / Code smells
- **Location:** `src/enterprise/client/features/admin/settings/hooks/useSettingsPolicyEditor.ts:41`
- **Problem:** A 716-line hook owns hydration, local persistence, conflict state, ownership filtering, navigation blocking, editing, validation, save, publish, reset, compensation, and refresh behavior.
- **Evidence:** It maintains at least 15 state/ref/reducer slots, implements the major workflows across lines 382–678, and returns more than 30 fields/actions to the page.
- **Impact / failure scenario:** Cross-cutting bugs such as hidden-row normalization and post-commit refresh misreporting are difficult to isolate because ownership, mutation, and presentation state change in the same callbacks.
- **Recommendation:** Extract focused hooks/controllers for owned-draft projection, CAS/conflict persistence, validation/publish, and reset compensation. Keep the page-facing hook as a small composition layer.

Dimension 4: no significant findings. Static and dynamic admin keys reviewed in this partition are present in both the English source and `locales/zh-CN/admin.json`, with matching interpolation variables and no verified hardcoded user-facing TSX copy.

### Metrics

- Total findings: 11 (CRITICAL 0, HIGH 2, MEDIUM 5, LOW 4)
- Largest in-scope files (lines): `adminSettingsService.test.ts` 909, `registry.ts` 746, `adminBrandingService.ts` 731
- Dead-code candidates verified unused repo-wide: 7
