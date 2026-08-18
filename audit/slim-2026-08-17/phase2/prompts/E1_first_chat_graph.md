# E1 — static import-graph attribution of the "first chat request" (read-only exploration, ~30 min)

Read /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/prompts/COMMON_RULES.md first (you are E1: read-only,
no edits anywhere; only write your report). REPO = /Users/konata/code/AIHub-worktrees/slim2.

## Why
Phase 1 made every tRPC sub-router lazy; the biggest remaining resident-memory jump is the FIRST chat request, which hydrates
`lambda.aiAgent` → `apps/server/src/services/aiAgent/index.ts` (~3.6k lines) → `apps/server/src/services/toolExecution/serverRuntimes/index.ts`
(30 static runtime imports) → many `packages/builtin-tool-*/src/ExecutionRuntime/**` and their deps (embeddings, sandbox, search
providers, notebooks, discord/telegram already lazy). Measured baseline (phase 1, `explore/G0c_all_lazy.md`): after a typical burst
~375 MB RSS / ~1500 loaded modules. G1 (a coding agent running in parallel) will make the server-runtime registry lazy per identifier
and needs to know **what else** on the first-chat graph is heavy and lazy-able.

## Do (static analysis only — no build, no server start)
1. Build the import graph starting from these roots (TypeScript sources, follow workspace packages `@lobechat/*` → `packages/*/src`,
   `@/…` → apps/server/src (see apps/server/tsconfig paths) and `~/…` if used). Stop at node_modules boundaries but RECORD each external
   package name reached with an estimated size (`du -sk node_modules/.pnpm/<pkg>*/node_modules/<pkg>/dist` or the package `main`
   file size — one number per package is enough):
   - apps/server/src/routers/lambda/aiAgent.ts (and any `aiAgent*` router file)
   - apps/server/src/services/aiAgent/index.ts
   - apps/server/src/services/toolExecution/serverRuntimes/index.ts
   - apps/server/src/modules/AgentRuntime/** (the server agent runtime + adapters)
   Write a small node/bun script in your scratch dir (/private/tmp/claude-501/-Users-konata-code-AIHub/9345b506-f4c4-43e9-8306-200ae4e11e70/scratchpad/e1/)
   — a simple regex import scanner + resolver is fine (`bunx madge --json` also works if it resolves the tsconfig paths).
2. Produce: (a) total reachable source files + total bytes; (b) top-30 heaviest subtrees by *exclusive* bytes (a subtree = a
   `packages/<pkg>` or `apps/server/src/<dir>` or an external package), each with the ONE import edge that pulls it in
   (file:line) and whether that edge is already inside a lazy seam; (c) for each of the 30 server runtimes in
   `serverRuntimes/index.ts`, the exclusive weight of its ExecutionRuntime subtree + externals; (d) anything imported at module
   top-level in aiAgent/index.ts that is only used inside one code path (candidate for `await import()`), e.g. heterogeneous agents,
   builtin skills, prompts, context-engine SkillEngine, remote-device prompt generators.
3. Also check the CLIENT-facing side quickly: `packages/builtin-tools/src/index.ts` imports each `@lobechat/builtin-tool-*` root — confirm
   each root index exports only manifest/systemRole/types (no runtime), list any that export more.

## Report → REPO/audit/slim-2026-08-17/phase2/reports/E1.md (≤120 lines)
Tables for (b), (c), (d) + a ranked "lazy seams" list: seam (file:line) → subtree → est. bytes → risk (types-only? used on every
message? used only when tool X is called?). No opinions beyond that; numbers first. Final message = report path + the top-10 seams.
