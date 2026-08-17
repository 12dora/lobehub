# G3 — Upstream module gating: lazy tRPC routers + FEATURE_FLAGS derivation + eager heavy imports

Read ../prompts/COMMON_RULES.md first (ownership: you are **G3**). Then explore/E2_modules.md §B1/B5/B8/C2 and
E1_runtime.md §B2/C5/D6. Work only in /Users/konata/code/AIHub-worktrees/slim. A build spike (G0) is running in parallel
and will write ../explore/G0_spike.md (lazy() chunk-split verdict + provenance table for sharp/@aws-sdk/xlsx/xmldom/search
providers/builtin-tools). Start with 1–2 now; check for that report before doing 3.

## Deliverables
1. `apps/server/src/enterprise/routers/moduleRouter.ts` (new fork helper):
   `moduleRouter<T extends AnyRouter>(moduleId, load: () => Promise<{ default?: T } | Record<string, T>>, pick?)` that returns a router
   whose type is `T` and which:
   - when the module is enabled (hot check `isModuleEnabled(moduleId)`), lazily imports and delegates (use `@trpc/server`'s exported
     `lazy()` if it fits — verify in node_modules/@trpc/server 11.18 `dist/unstable-core-do-not-import*.d.mts`; otherwise implement
     with a memoized import + tRPC `router({})` proxy that keeps the same procedure paths);
   - when disabled, every procedure throws the enterprise `PLATFORM_MODULE_DISABLED` error (FORBIDDEN, data.moduleId) — the router
     SHAPE (procedure names/types) must stay identical so `LambdaRouter` types don't drift and existing clients type-check.
   Simplest robust design: keep the static import for the type only (`import type { KnowledgeBaseRouter }`), and produce the router
   via `lazy(async () => { const m = await import('./knowledgeBase'); return wrapWithModuleGuard(m.knowledgeBaseRouter, moduleId) })`
   where `wrapWithModuleGuard` adds a middleware to every procedure — check tRPC v11 APIs (`router._def.procedures`,
   `t.mergeRouters`, or wrapping via a `t.middleware` at the sub-router's `t` instance). If per-procedure wrapping is not feasible,
   fall back to: lazy import + a guard *inside* the loader that returns a stub router built by iterating `_def.procedures` (same
   names, each `publicProcedure.query/mutation(() => { throw })`) — but this must be a `.use()`-compatible shape. Document the choice.
   Unit-test: enabled ⇒ delegates; disabled ⇒ FORBIDDEN with moduleId; import happens once; **no import at module-evaluation time**.
2. Apply it as ONE-LINE replacements in `apps/server/src/routers/lambda/index.ts` (and `async/index.ts`, `tools/index.ts`,
   `mobile/index.ts` where those keys exist) for every key listed in `PLATFORM_MODULES[*].lambdaRouterKeys/asyncRouterKeys/toolsRouterKeys`
   (packages/const/src/platform/modules.ts). Before applying, VERIFY each key really belongs to that module (e.g. `document`/`file`
   are core; `device` may be shared with desktop auth — check) and correct the lists in modules.ts (you may edit only the router-key
   arrays). Do not touch `admin`/`platform` keys (fork, guarded elsewhere). Make sure the registry reconcile tests
   (`apps/server/src/enterprise/security/policy/adminProcedureAuthorization/*.test.ts`) and any test that enumerates the lambda router
   still pass; if something enumerates lazy routers at import time and breaks, prefer fixing the consumer over dropping lazy.
3. **FEATURE_FLAGS derivation** in `apps/server/src/featureFlags/index.ts` (upstream; keep tiny): after computing merged flags,
   for each module with `featureFlagKeys` that is disabled (hot check) force those keys to `false`. Do it in a small fork helper
   (`apps/server/src/enterprise/services/moduleSettings/featureFlagOverrides.ts`, you may create this one file under G1's dir —
   coordinate by keeping it self-contained) and call it from ONE place. Test: `knowledgeBase` off ⇒ `enableKnowledgeBase=false`.
4. **Eager heavy imports** (after G0's provenance table): convert the identified static imports of `sharp`, `@aws-sdk/client-s3`
   (via `@/server/modules/S3`), `xlsx`, `@xmldom/xmldom`, `discord.js` etc. that sit on the BOOT path into `await import()` at the use
   site — only where the change is a local, mechanical edit (upstream-friendly). Also gate the two static fan-outs:
   `apps/server/src/services/search/impls/index.ts` (11 providers → resolve provider lazily by name) and
   `packages/builtin-tools/src/index.ts` (28 packages; `defaultToolIds` uses 12) — only if it can be done without changing public
   exports; otherwise document why not. Any file you touch outside your list: STOP and note it.
5. Verify boot behaviour locally: `cd REPO && bun run check --test <files>`; if feasible, run the Next dev server briefly to make sure
   the lambda router still serves `platform.getPublicSnapshot` and a lazy router (e.g. `knowledgeBase`) responds; with
   `LOBE_MODULES_DISABLED=knowledgeBase` it returns FORBIDDEN `PLATFORM_MODULE_DISABLED` (not 404).

Report ../reports/G3.md with: the exact list of gated keys per root router, the helper design, and the eager-import table (dep → change).
