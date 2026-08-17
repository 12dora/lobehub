The sandbox blocked creation of `REVIEW_G4.md` because it is read-only. The requested report is printed below.

# G4 code review

VERDICT: REWORK

## FINDINGS

1. **BLOCKER · apps/server/src/enterprise/services/contentModeration/regexWorker.ts:176 · [VERIFIED]** · Unexpected worker death leaves `compiledDigests` populated, while the replacement worker starts with an empty `compiledByDigest`. The next request for the same digest omits `patterns`; the worker compiles an empty rule list and returns no matches. A worker crash can therefore bypass regex moderation. Clear `compiledDigests` in every death handler and add a same-digest crash regression test.

2. **BLOCKER · src/libs/oidc-provider/userActiveCache.ts:84 · [VERIFIED]** · An auth check started at epoch N can finish after `bumpUserActiveCacheEpoch()` and call `remember()` using the new global epoch. If its DB statement saw the pre-ban state, it repopulates an `ok: true` entry after the ban/revoke committed, allowing requests for up to five seconds. Capture the flight’s starting epoch and cache only if it remains current; add an in-flight-check/epoch-bump race test.

3. **BLOCKER · apps/server/src/enterprise/services/settings/runtimeSettingsAdapter.ts:46 · [VERIFIED]** · The requested request-scope dedupe is a process-wide two-second cache keyed only by user ID, with no production invalidation. After `user.updateSettings`, a new message can use stale memory/timezone settings, changing the unconfigured/default path and violating rules 5 and 6. Dedupe inside one `execAgent` invocation or invalidate from every settings writer; test an update between separate requests.

4. **BLOCKER · packages/business/model-bank/src/lib/model-config.ts:42 · [VERIFIED]** · `modelsMemo` has no TTL, and its only explicit reset is test-only; `packages/model-bank/src/aiModels/index.ts:204` also adds a memo without TTL. Rule 6 requires every cache to have TTL and invalidation. Add bounded TTLs plus production invalidation/version handling to both slots and cover expiry.

5. **BLOCKER · apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:48 · [VERIFIED]** · Both the AI snapshot slot and 128-entry checksum memo lack TTLs; the checksum memo is only cleared by a test helper, not by catalog invalidation. This violates rule 6 despite bounded storage. Add TTL metadata and production invalidation, with expiry/invalidation tests.

6. **MAJOR · apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:111 · [VERIFIED]** · `peekGeneration()` errors are swallowed and treated as generation zero. The model already returns zero for an absent row and deliberately throws real DB/relation/permission failures. After a generation-zero load, later failures can return a stale snapshot without attempting the authoritative join, contradicting the fail-closed invariant. Remove the broad catch and model missing rows as successful generation-zero results in tests.

7. **MAJOR · apps/server/src/enterprise/services/networkProxy/engine/bindEgress.ts:17 · [UNVERIFIED]** · The binder uses `createRequire('../egress/scope')` and silently suppresses failures. Direct Node resolution from this source returns `MODULE_NOT_FOUND`, and no standalone tracing include covers the module. If production behaves likewise, the ALS hook is absent and plain outbound fetches bypass proxy/SSRF routing. Use a bundler-traceable awaited import during boot, surface failures, and verify hook registration in a standalone integration test.

8. **MAJOR · apps/server/src/enterprise/services/networkProxy/snapshot.ts:311 · [VERIFIED]** · The fast path still calls `DomainConfigCache.get()`, whose `cloneValue` performs `structuredClone` on the full YAML-bearing snapshot. Every warm fetch therefore still clones the full snapshot once. It also returns `lastEgressView` directly, allowing mutation of the shared slot. Cache/project before the full clone and return a small cloned view; test cloning cost and mutation isolation.

9. **MINOR · apps/server/src/enterprise/services/platformConfigInvalidation.ts:305 · [VERIFIED]** · A publish can delete a scope slot while an older read is in flight, but that read later reintroduces its stale value for one second. This remains within the cross-instance bound, but local invalidation is not immediate. Associate reads with a per-scope generation and cache only if unchanged; add a read/publish race test.

## METRICS

- Files reviewed: **41** — 32 tracked diffs and 9 untracked files read in full.
- Upstream files touched:
  - `apps/server/src/globalConfig/{index.ts,getServerGlobalConfig.test.ts,aiProvidersCache.ts,aiProvidersCache.test.ts}` — obeys rule 4: wrapper memo plus minimal required config-field replacement/tests.
  - `apps/server/src/services/aiAgent/index.ts` — obeys: import plus one-line call replacement.
  - `packages/business/model-bank/src/lib/model-config.ts` and `packages/model-bank/src/aiModels/{index.ts,__tests__/index.test.ts}` — obeys: wrapper/memo changes and targeted tests.
  - `packages/trpc/src/lambda/{context.ts,context.test.ts}` — obeys: import replacement, one-line call swaps, and test adjustment.
  - `packages/types/src/serverConfig.ts` — obeys the G4-brief exception: targeted optional contract field.
  - `src/business/model-config.test.ts` — obeys: targeted test only.
  - `src/libs/oidc-provider/{userActiveCache.ts,userActiveCache.test.ts}` — obeys: wrapper/memo helper and targeted test.
- No migration or i18n files were in G4 scope. Scoped contract export names were preserved.

## UNVERIFIED

- Vitest was not run, per instruction.
- `bunx tsgo --noEmit -p tsconfig.json` produced no output and did not complete before interruption; project type correctness is unverified.
- Docker/Next standalone bundling was not built; finding 7 is based on source resolution, tracing configuration, and the fail-soft path.
- Report-file creation was attempted but rejected by the read-only sandbox.