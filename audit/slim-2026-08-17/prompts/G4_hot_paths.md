# G4 — Hot-path algorithmic fixes (per-request / per-message) + `enterprise.modules` in server config

Read ../prompts/COMMON_RULES.md first (ownership: you are **G4**). Then explore/E5_request_path.md §B2/B3/B4/B6/B9/C (rows 4-8)
and E4_admin_setup.md §B8. Work only in /Users/konata/code/AIHub-worktrees/slim. All items are behaviour-preserving
optimizations; each needs a test proving the observable result is unchanged plus a test proving the cache/dedupe.

## Deliverables (ordered by value)
1. `apps/server/src/globalConfig/index.ts` (upstream): (a) memoize the expensive part of `getServerGlobalConfig()` — the
   86-provider `genServerAiProvidersConfig()` result — with a process-level cache keyed by an env fingerprint (+ infra snapshot
   revision if it feeds in), TTL 60s, single-flight; do NOT cache the whole config object (fork fields such as `enterprise` and
   `enableUploadFileToServer` are dynamic). Wrap, don't rewrite. (b) add `modules: (await getModuleSettingsSnapshot()).effective`
   to the `enterprise: {...}` block (~:133) — this is how the SPA HTML gets `window.__SERVER_CONFIG__.config.enterprise.modules`
   (type field added by G1 in packages/types/src/serverConfig.ts as `modules?: Record<string, boolean>` — if not yet present, add
   the optional field yourself and tell G1 in your report). Test: two calls within TTL compute providers once; enterprise.modules
   reflects `LOBE_MODULES_DISABLED`.
2. `apps/server/src/enterprise/guards/userActiveCache.ts` (new): a 5s process TTL cache for `assertUserActive` keyed by
   `userId + credentialIssuedAt/sessionId`, invalidated by an epoch that ban / invalidate flows can bump (find where user
   invalidation happens — `auth_invalidated_at` writes — and bump the epoch there if it is fork code; if it lives in upstream code,
   keep TTL small and document). Wire it in `packages/trpc/src/lambda/context.ts` at the 3 call sites with a one-line swap to
   `assertUserActiveCached` (import from the fork helper). Tests: cached within TTL, epoch bump invalidates, inactive still throws.
3. `loadModels()` memo: `src/business/client/model-bank/loadModels.ts` (fork stub always passes `providerLoaders`, defeating the
   memo in `packages/model-bank/src/aiModels/index.ts:219-228`) — make the fast path reachable (memoize by loaders identity / a
   version key) so each LLM step doesn't rebuild 1943 models. Keep upstream change to a wrapper/memo. Test.
4. `platform.getPublicSnapshot`: `apps/server/src/enterprise/services/branding/resolvePublicSnapshot.ts` — process cache 5–10s
   (invalidate on the existing branding/auth-settings invalidation hooks). It is polled by every anonymous tab every 30s.
5. `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts` + `aiCatalog/runtimeAdapter.ts`: cache the
   catalog snapshot by max revision / row count (or an epoch), and compute `checksumPayload` only for changed rows (memo by
   `providerId + revision`). E5 B9 #2: today every message re-joins and re-hashes every published provider payload.
6. `apps/server/src/enterprise/runtimeConfig/domainCache.ts` + `services/platformConfigInvalidation.ts`: memoize the Redis
   scope-version read for ≤1s (per scope) so a cache hit costs 0 Redis RTTs in the common case; keep correctness of
   cross-instance invalidation within that 1s.
7. Network proxy: `services/networkProxy/snapshot.ts` + `egress/**` — the egress consumer only needs 4 fields (see `egress/deps.ts`);
   project once and stop `structuredClone`-ing the full snapshot (which contains decrypted subscription YAML) twice per outbound
   fetch. Preserve every observable decision of `resolveEgress`. Tests exist there — extend.
8. Content moderation: `runtime/moderationAwareRuntime.ts` + `decisionService.ts` fetch the snapshot twice per message → once;
   `regexWorker.ts` — send rules to the worker once per rules version, not per message (keep the 50ms circuit breaker semantics);
   `keywordMatcher.ts` only if needed.
9. `services/settings/runtimeSettingsAdapter.ts` + the two `getUserSettings()` calls per message in `apps/server/src/services/aiAgent/index.ts:~2440-2452`
   → dedupe within one message (request-scope memo in the fork adapter; upstream file change ≤2 lines or none).

Rules: no semantic changes; every cache has a TTL and an invalidation path; no unbounded Maps (LRU or single-slot). Report
../reports/G4.md with a table item → file → mechanism → measured/estimated saving → tests.
