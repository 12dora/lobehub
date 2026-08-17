# VERDICT: REWORK

## FINDINGS

1. **BLOCKER · `src/instrumentation.ts:56` · Verified** · `startEnterpriseWorkers()` starts the `gatewayService` spec (`workersBootstrap.ts:195`), then instrumentation immediately runs the legacy GatewayService auto-start block again at line 67. On the default all-enabled path this introduces duplicate, potentially concurrent reconciliation/DB and gateway mutations, violating rule 5. Keep the registry-owned start and remove the legacy auto-start block, with a test using the real registry seam to assert one invocation.

2. **BLOCKER · `apps/server/src/enterprise/services/networkProxy/engine/bindEgress.ts:20` · Verified** · Failure to import the egress binding is logged and swallowed. Execution then continues without the global hook, and `ModelRuntime` falls back to direct outbound fetches. A read-only Bun reproduction triggered this path and left the binding absent. This can bypass configured network-proxy enforcement. Clear the latch and rethrow; the registry’s per-spec catch will still allow other workers to start. When `networkProxy` is enabled, runtime construction must fail closed if the binding is unavailable.

3. **BLOCKER · `scripts/enterprise/pathBoundaries.ts:660` · Verified** · The 54-line allowlist expansion is an upstream modification that is neither a one-line guard/replacement, wrapper-memo, nor `await import()` swap. The multi-line changes to `src/instrumentation.test.ts` and `gatewayStart.test.ts` likewise exceed rule 4’s permitted upstream forms. Move coverage into enterprise-owned test files and reduce upstream seams to the allowed mechanical changes; any boundary-policy exception needs commander ownership.

4. **MAJOR · `src/app/(backend)/api/workflows/[[...route]]/route.ts:5` · Verified** · This gate protects only the catch-all. The ten concrete `/api/workflows/agent-eval-run/**/route.ts` handlers outrank it and remain executable when `workflows` is disabled. Wrap every concrete workflow `POST` export with a shared enterprise gate that returns the required 403 body, using one-line replacements to satisfy rule 4, and add an alternate-route regression test.

5. **MAJOR · `src/server/agent-hono/index.ts:34` · Verified** · The hot middleware runs before `gatewayStart`, so disabled bots receive its generic 403 and never reach the handler’s promised HTTP 200 `{ ok:false, disabled:true }`. Consequently the standalone launcher can still retry ten times. Special-case `/api/agent/gateway/start` in the middleware, or exempt it and let the boot-view handler answer; test through the complete Hono app rather than invoking the handler directly.

6. **MAJOR · `apps/server/src/enterprise/bootstrap/workersBootstrap.ts:63` · Verified** · Readiness registration for `managedAi` and `managedSkills` is boot-gated even though both modules are `kind: 'hot'`. If either is disabled at boot and enabled later, its probe remains permanently unregistered and readiness stays false until restart. Register these zero-I/O probes unconditionally and perform any module check inside the probe using the hot view; add a disabled-at-boot then hot-enable regression test.

7. **MAJOR · `src/server/agent-hono/index.ts:5` · Verified** · All bot, gateway, messenger, and webhook handlers are statically imported before `webapiModuleGate` runs. A disabled `bots` module therefore still loads the optional GatewayService/chat-platform graph, defeating the slimming goal; `gatewayStart.ts:4` independently imports GatewayService before its guard. Replace optional handler imports with lazy handler wrappers using `await import()` after middleware admission.

8. **MINOR · `apps/server/src/enterprise/services/networkProxy/engine/platform.ts:50` · Verified** · The `resolveDataDir`/Turbopack tracing rewrite is outside G2’s “engine start predicate only” ownership and is absent from the report’s file list. Remove this hunk from G2 and hand it to the deployment owner if still needed.

## METRICS

- Files reviewed: **29** — 24 tracked diffs and 5 untracked files read in full.
- Upstream touches obeying rule 4:
  - `apps/server/src/modules/ModelRuntime/index.ts` — **Yes**, guarded fork call plus lazy import swap.
  - `src/instrumentation.ts` — **Yes**, boot wrappers/dynamic imports and a guard; no unrelated reformat.
  - `src/app/(backend)/api/workflows/[[...route]]/route.ts` — **Yes**, single early gate.
  - `src/server/agent-hono/index.ts`, `src/server/workflows-hono/index.ts` — **Yes**, one middleware mount each.
  - `src/server/agent-hono/handlers/gatewayStart.ts` — **Yes**, early guard.
- Upstream touches not obeying rule 4:
  - `scripts/enterprise/pathBoundaries.ts` — **No**, 54-line allowlist expansion.
  - `src/instrumentation.test.ts` — **No**, multi-line test expansion.
  - `src/server/agent-hono/handlers/__tests__/gatewayStart.test.ts` — **No**, multi-line test expansion.

## UNVERIFIED

- Vitest was not run because the sandbox is read-only.
- `tsgo --noEmit --incremental false -p tsconfig.json` was attempted; it stopped on unrelated `src/components/mdx/Image.tsx:34` (`placeholder` prop), with no G2-path diagnostic emitted. A clean full type check remains unverified.
- Production Next/Turbopack bundle tracing and runtime gateway concurrency were not executable here.
- `git diff --check` passed for the scoped tracked files.