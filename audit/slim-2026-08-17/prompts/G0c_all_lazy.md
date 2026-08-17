# G0c — Spike: what if EVERY lambda sub-router is lazy? (+ preloadEntriesOnStart)

Same spike worktree /Users/konata/code/AIHub-worktrees/spike (contains round-1 batch code + your harness). Your G0b result:
module presets save ~44 MB at boot but every tier climbs back to ~650 MB after the first tRPC request, because the lambda entry
statically imports ~50 core routers whose graph (services, builtin-tools, model-bank, bots via some core edge …) is the real bulk.

Experiment C: in `apps/server/src/routers/lambda/index.ts` turn EVERY sub-router except `admin`, `platform`, `healthcheck`, `config`
and `user` into a lazy one using the fork helper's primitive: `lazy(() => import('./x').then(m => m.xRouter))` from
`@trpc/server/unstable-core-do-not-import` (no module gate needed for the spike — plain lazy; the type helper `Lazy<NoInfer<T>>`
issue is irrelevant for the build). Do the same for `async/index.ts`, `tools/index.ts`, `mobile/index.ts` (all keys except
healthcheck). Rebuild (`DOCKER=true next build`) and re-run your boot matrix for config (a) default only, 3 boots, measuring:
  1. boot RSS / heap / chunk bytes / module count;
  2. after `GET /trpc/lambda/platform.getPublicSnapshot`;
  3. after a "typical session" burst — call these (unauthenticated is fine, 401s still load the router chunk; use the batch link
     format or one-by-one): `config.getGlobalConfig`, `user.getUserState`, `session.getSessions`, `topic.getTopics`,
     `message.getMessages`, `agent.getAgents`, `aiProvider.getAiProviderRuntimeState`, `aiModel.getAiProviderModelList`,
     `file.getFiles`, `plugin.getPlugins`, `home.getRecent`(any 10 common ones that exist) — record RSS/heap/modules after each burst;
  4. Ready time; first-request latency for a lazy router (cold) vs warm.
Then Experiment D (one more rebuild): additionally set `experimental.preloadEntriesOnStart: false` in `next.config.ts` (Docker branch)
and repeat 1–4. Report the same table for baseline-round1 (from G0b), C, C+D.
Also count `discord.js` / `sharp` / `@aws-sdk` paths in Module._cache at each stage.

Report → audit/slim-2026-08-17/explore/G0c_all_lazy.md
(≤120 lines): A. table; B. verdict — is "all routers lazy" worth doing for real (RSS after a typical session, cold-latency cost);
C. any breakage (types are irrelevant here — runtime only). Time budget ~75 min. Final message = path + section A+B verbatim.
