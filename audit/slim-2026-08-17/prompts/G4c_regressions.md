# G4c — three regressions found by the commander's broad test run (your caches)

Tree /Users/konata/code/AIHub-worktrees/slim, you are still G4. These suites PASS on main and FAIL on our branch; each is caused by
one of your round-1/2 caches. Fix the cache semantics (not the tests) unless a test mock is genuinely incomplete:

1. `apps/server/src/enterprise/services/aiCatalog/publication.test.ts` › "rejects direct DB credential and sensitive-endpoint pollution
   before revision/public output": expected public output `[]` after the rejected publication, got 1 provider. Suspect: your
   catalogAuthority snapshot slot / checksum memo serves a stale or half-written state (generation/epoch keying) — the rejected
   publication must never leak into the public snapshot, and a rolled-back transaction must not leave the slot populated.
2. `apps/server/src/enterprise/services/connectorGovernance/service.test.ts` › "serves from cache within TTL and drops it when publish
   bumps the invalidation scope": your ≤1s scope-version memo (platformConfigInvalidation) makes a publish-driven scope bump invisible
   in-process. Local `publish` must drop the memo for those scopes immediately AND a bump observed through the publisher used by that
   test must be seen (read how the test bumps the version — via `getPlatformConfigInvalidationPublisher().publish` or a mocked
   `getScopeVersion`?). If the memo cannot honour that path, key the memo per scope+read-generation as reviewed, or shorten the memo to
   "single in-flight dedupe" (coalesce concurrent reads, no time-based memo).
3. `apps/server/src/enterprise/services/settings/adminSettingsService.test.ts` › "accepts the rolled-back AI pointer even when higher
   history lacks the model": now rejects with PLATFORM_CONFIG_VALIDATION_FAILED. Suspect: catalog snapshot cache returning the wrong
   revision after a rollback (pointer moved to an older revision while the slot still holds the newer one) or your `peekGeneration`
   fail-closed change. The rolled-back pointer must be visible immediately after rollback.

Also (already fixed by the commander, FYI): `skillCatalog/publication.test.ts` mock lacked your new `onAiCatalogAuthorityInvalidate`
export. Check other test files that `vi.mock('../platformInstance/catalogTokens' …)` or `platformConfigInvalidation` and add the new
exports where missing.

Verify: the three suites + your own list + `apps/server/src/enterprise/services/aiCatalog`, `platformInstance`, `connectorGovernance`,
`settings` directories (`bunx vitest run --silent='passed-only' <dirs>`), lint. Append "Round 3" to
…/scratchpad/slim/reports/G4.md. Final message: 6 lines.
