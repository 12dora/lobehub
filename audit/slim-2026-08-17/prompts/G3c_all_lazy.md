# G3c — Make ALL optional-able lambda/async/tools/mobile sub-routers lazy (measured −280 MB after a typical session)

Tree /Users/konata/code/AIHub-worktrees/slim, you are still G3. Read the spike result first:
audit/slim-2026-08-17/explore/G0c_all_lazy.md
Verdict: with every sub-router lazy (except `admin`, `platform`, `healthcheck`, `config`, `user`) RSS after a typical session drops
from ~650 MB to ~528 MB, and with Docker `preloadEntriesOnStart:false` to ~375 MB; cold latency of a lazy router +~20 ms once.

## Do
1. Add a tiny fork helper next to `moduleRouter.ts`: `lazyRouter<T extends AnyRouter>(load: () => Promise<T>): Lazy<NoInfer<T>>`
   (plain tRPC `lazy()`, no module gate; same `NoInfer` trick — see the comment in `moduleRouter.ts`). Keep `moduleRouter` for the
   module-gated ones.
2. In `apps/server/src/routers/lambda/index.ts` (and `async/index.ts`, `tools/index.ts`, `mobile/index.ts`) replace EVERY remaining
   static sub-router mount with `lazyRouter(() => import('./x').then((m) => m.xRouter))` EXCEPT: `admin`, `platform`, `healthcheck`,
   `config`, `user` (lambda), and `healthcheck` on the other roots. Keep the module-gated ones as `moduleRouter(...)`. One line per key,
   nothing else in those files changes. Delete the now-unused static imports (they must not remain, or the graph stays eager). Type-only
   imports are fine.
3. Verify the client types still infer (this is the trap: `Lazy<NoInfer<T>>`), by running the full type check ONCE at the end:
   `bunx tsgo --noEmit -p tsconfig.json` (≈1 min here) — zero new errors (baseline has exactly one at src/components/mdx/Image.tsx).
4. Find every consumer that enumerates `lambdaRouter._def.procedures` / `_def.record` or relies on synchronous availability of a
   sub-router (grep `_def.procedures`, `_def.record`, `lambdaRouter\.` in apps/server, packages/trpc, src, scripts, e2e) and make sure
   they still work with lazy children (tRPC hydrates lazy routers on first access; `createCallerFactory` works). Fix or document.
5. Build-time regression from the measurement: the standalone build (page collect) logs
   `TypeError: (0 , c.onNetworkProxySnapshotChange) is not a function` at `apps/server/src/enterprise/services/networkProxy/egress/scope.ts:138`
   — a module-evaluation-order cycle around `egress/scope` (`scope` → `../snapshot`, `./deps` → `../snapshot`, `../engine/runtime`,
   `../../chatgptWeb/transport/curlImpersonateFetch` → back into egress?). Find the cycle (`bunx madge --circular --extensions ts
   apps/server/src/enterprise/services/networkProxy` or manual) and break it with the "third shared module + lazy require at the call
   site" pattern (the module-level `onNetworkProxySnapshotChange(...)` subscription in scope.ts is the likely trigger — register it from
   `bindEgress` at boot instead of at import time). Add a test that imports `egress/scope` first and `snapshot` second (and vice versa)
   without throwing.
6. Run: `cd packages/trpc && bunx vitest run`; `bunx vitest run --silent='passed-only' apps/server/src/routers apps/server/src/enterprise/routers
   apps/server/src/enterprise/security apps/server/src/enterprise/services/networkProxy src/server`; lint on touched files.
7. Append "Round 3 (all-lazy)" to …/scratchpad/slim/reports/G3.md with the list of lazy keys per root and any consumer you had to fix.
   Final message: 8 lines. Do NOT touch next.config.ts (G5 will flip `preloadEntriesOnStart` there).
