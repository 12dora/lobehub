# G3b — Rework after review (upstream module gating) + eager heavy imports round 2

Same tree /Users/konata/code/AIHub-worktrees/slim, you are still G3. Absolute paths this time:
- Rules: audit/slim-2026-08-17/prompts/COMMON_RULES.md
- Your previous brief/report: …/scratchpad/slim/prompts/G3_upstream_routers.md, …/scratchpad/slim/reports/G3.md
- Review: audit/slim-2026-08-17/reviews/REVIEW_G3.out.md
- Spike facts (provenance of heavy boot imports): …/scratchpad/slim/explore/G0_spike.md §C and …/explore/G0b_measure.md (if present)
Note: the commander already changed `moduleRouter.ts` (`load: () => Promise<T>` + `Lazy<NoInfer<T>>` — the union type let TS
collapse T to AnyRouter inside `router({...})`, breaking every client call). Keep that.

Commander's adjudication of the review (do exactly this):
1. ACCEPT F1 (BLOCKER): `packages/trpc/src/async/init.ts` errorFormatter must carry the same `errorData` payload as the lambda
   one (mirror `packages/trpc/src/lambda/init.ts:19-28`), so a disabled async procedure serializes FORBIDDEN + `PLATFORM_MODULE_DISABLED`
   + `details.moduleId`. Test at the formatter level.
2. ACCEPT F2 (BLOCKER→MAJOR): server tool runtimes bypass module gates. Add ONE guard at the tool-execution dispatch boundary
   (find the single place that resolves a server runtime by tool identifier — `apps/server/src/services/toolExecution/**`), mapping
   tool identifier → module id via a small fork table (`apps/server/src/enterprise/guards/toolModuleGate.ts`: knowledge-base tool
   → knowledgeBase, memory tool → memory, web-browsing/search → webSearch, image/video generation → imageGen, market/skill-store →
   market, sandbox/python → sandbox, remote-device → deviceGateway). Disabled ⇒ throw the enterprise `PLATFORM_MODULE_DISABLED`
   before any side effect. Upstream touch = one import + one line. Test: disabled module ⇒ rejected before the runtime runs.
3. ACCEPT F3 (BLOCKER): restore `apps/server/src/featureFlags/index.ts` to its ORIGINAL control flow (`git diff HEAD` on it) and
   apply `applyDisabledModuleFeatureFlagOverrides(...)` as a one-line wrapper at the public export(s).
4. ACCEPT F4 (BLOCKER): `apps/server/src/services/search/impls/index.ts` must stay mechanically close to upstream: keep the file's
   shape; each static provider import becomes a lazy loader entry (`() => import('./brave')` etc.) in the SAME map/switch the file
   already had, and the memoized "load once + delegate" wrapper moves to a fork helper
   (`apps/server/src/enterprise/services/search/lazySearchImpl.ts`) imported with one line. If that is not possible without a big
   diff, REVERT the file to HEAD and record why (the boot-set saving of these 11 providers is small).
5. F5: fine (G1 owns those files; make sure there is exactly one `PLATFORM_MODULE_DISABLED` definition and one mapping — check
   `git diff HEAD -- packages/const/src/platform/errorCodes.ts apps/server/src/enterprise/guards/enterpriseErrors.ts`).
6. ACCEPT F6+F7 (MAJOR): eager heavy imports (this is the RSS win of the batch, treat it seriously) — per G0 §C:
   a. `sharp`: `apps/server/src/services/aiAgent/ingestAttachment.ts` → `await import('sharp')` at the compress site (mechanical);
      `apps/server/src/enterprise/services/branding/assetStorage.ts` (fork) → dynamic import inside the function that needs it, and
      make sure `branding/index.ts` barrel does not pull it at import time; `services/generation/{index,video}.ts` are behind the lazy
      imageGen routers already — verify nothing else statically imports them on the boot path (grep importers).
   b. `@aws-sdk/client-s3`: `apps/server/src/modules/S3/index.ts` — construct `S3Client` lazily on first use (a getter/`ensureClient()`
      inside the class; public API unchanged) or lazy-import the SDK inside the class methods; goal: no `@aws-sdk` module in the boot
      set when nothing touched files. Keep the diff local to that file.
   c. `xlsx`: `packages/eval-dataset-parser/src/parsers/xlsx.ts` → `await import('xlsx')` inside `parseXLSX` (make it async if it isn't;
      adjust the one caller).
   d. `discord.js` and the 9 bot adapters: `apps/server/src/services/bot/platforms/index.ts` — is `platformRegistry` reached from any
      core (non-lazy) path? (G0: `lambda/agentBotProvider.ts:22`, now lazy; `GatewayService` gated by bots). If any other core path
      imports it, make it lazy by id; else just document that bots-off keeps it out of the boot set.
   e. `packages/builtin-tools/src/index.ts` (28 packages): leave as documented (public sync exports) unless a ≤10-line change makes
      the *manifests* lazy without changing exports; document.
   Add scoped tests for the search lazy factory (no evaluation-time import, mapping, import-once, Search1API auto flag) as the
   review asks.
7. Verify: `bun run .agents/scripts/check/cli.ts --lint --test <files>`; targeted vitest incl. `apps/server/src/services/search`,
   `packages/trpc` (`cd packages/trpc && bunx vitest run`), toolExecution tests. Update …/scratchpad/slim/reports/G3.md (append
   "Round 2" section). Final message: 10 lines.
