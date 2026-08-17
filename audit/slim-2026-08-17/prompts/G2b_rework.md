# G2b — Rework after review (boot gates)

Same tree /Users/konata/code/AIHub-worktrees/slim, you are still G2. Absolute paths:
- Rules: audit/slim-2026-08-17/prompts/COMMON_RULES.md
- Your brief/report: …/scratchpad/slim/prompts/G2_boot_gates.md, …/scratchpad/slim/reports/G2.md
- Review: audit/slim-2026-08-17/reviews/REVIEW_G2.out.md
- Measurement of round 1: …/scratchpad/slim/explore/G0b_measure.md (read §B and §E: gateway/start returned 403 not 200; aiCatalogReadiness
  ReferenceError; discord.js re-enters the process on the first request even with bots off).

Adjudication (do exactly this):
1. ACCEPT F1 (BLOCKER): GatewayService must start exactly once. Remove the legacy auto-start block from `src/instrumentation.ts`
   (the registry's `gatewayService` spec is the single owner; keep the same env predicates inside the spec: non-Vercel, DATABASE_URL,
   `ENABLE_BOT_IN_DEV` in dev, bots module). Test with the real registry seam: one `ensureRunning` call.
2. F2 (bindEgress fail-soft): G4b is fixing `engine/bindEgress.ts` right now (dynamic import, surface failures) — do NOT touch that file.
3. REJECT F3 (`scripts/enterprise/pathBoundaries.ts` is a fork-owned script; test files may grow) — no action.
4. ACCEPT F4 (MAJOR): the ten concrete `src/app/(backend)/api/workflows/**/route.ts` handlers bypass the catch-all gate. Add a fork
   wrapper `withWorkflowsModule(handler)` (in `apps/server/src/enterprise/guards/webapiModuleGate.ts`) and apply it as a one-line change
   per route file (`export const POST = withWorkflowsModule(handler)` style, keeping the original handler intact). Map the two
   sub-mounts to their modules (`agent-signal` → agentSignal, `memory-user-memory` → memory) as your Hono gate already does. Test.
5. ACCEPT F5 (MAJOR): `/api/agent/gateway/start` must reach the handler when bots is off so it can answer HTTP 200
   `{ ok:false, disabled:true }` (the launcher polls it up to 10×). Exempt that exact path in `webapiModuleGate` (or order the mount
   after it). Test through the full Hono app.
6. ACCEPT F6 (MAJOR): readiness registrations for HOT-kind modules (`aiCatalogReadiness` → managedAi, `skillCatalogReadiness` →
   managedSkills; also `connectorCatalogReadiness` if managedConnectors readiness is zero-I/O) must be registered unconditionally at
   boot and check the HOT view inside the probe. Test: disabled-at-boot then hot-enabled ⇒ probe registered and answers.
7. Also fix (from G0b §E1): `aiCatalogReadiness` spec throws `ReferenceError` on real boot. G1b may look at the aiCatalog side; you own
   the spec: reproduce with a test that calls the spec `start()` unmocked and make it pass (likely TDZ / import order).
8. ACCEPT F7 (MAJOR): `src/server/agent-hono/index.ts` statically imports the bot/gateway/messenger/webhook handlers (and
   `gatewayStart.ts` imports GatewayService at module top) ⇒ the whole bot graph loads whenever the agent-hono entry loads. Convert the
   bots-owned handlers to lazy wrappers (`const handler = async (c) => (await import('./handlers/x')).x(c)`) — mechanical, one line
   each — and make `gatewayStart.ts` import GatewayService inside the handler after the module check. Goal: with bots off, `discord.js`
   never enters `Module._cache` even after requests. Then look for the OTHER core edge that G0b measured (discord.js 0 → 313 after the
   first `platform.getPublicSnapshot` request even with bots off): find which core (non-lazy) module imports
   `apps/server/src/services/bot/platforms` / `GatewayService` / `messenger` and break it with a lazy import (candidates:
   `services/aiAgent`, `services/agentNotify`, `routers/lambda/agentNotify.ts`, `services/messenger`, `runtimeBridge`). Report the edge
   you found and the fix.
9. REJECT F8 (`engine/platform.ts` resolveDataDir hunk is the commander's, keep it).
10. Re-run your tests + lint. Append "Round 2" to …/scratchpad/slim/reports/G2.md. Final message: 10 lines.
