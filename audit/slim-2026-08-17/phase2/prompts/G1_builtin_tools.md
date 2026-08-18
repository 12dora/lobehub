# G1 — P1: server tool-runtime registry lazy per identifier + first-chat-request graph slimming

Read /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/prompts/COMMON_RULES.md first (you are G1).
Then HANDOFF §1 P1: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/HANDOFF.md, and the referenced
`explore/G0_spike.md` §C, `reports/G3.md` ("builtin-tools"), `reports/G2.md` Round 2 items 7-8 (the `messageRuntime` lazy-factory
precedent in `apps/server/src/services/toolExecution/serverRuntimes/index.ts`). REPO = /Users/konata/code/AIHub-worktrees/slim2.

## Facts already checked
- `packages/builtin-tools/src/index.ts` imports only each `@lobechat/builtin-tool-*` ROOT (`manifest`/`systemRole`/`types`) — the
  execution runtimes live under the separate `./executionRuntime` export. So the manifest side is already light; the weight is
  `apps/server/src/services/toolExecution/serverRuntimes/index.ts` (30 static `import { xRuntime } from './x'` — each `./x` imports
  `@lobechat/builtin-tool-x/executionRuntime` and its deps) plus whatever `apps/server/src/services/aiAgent/index.ts` pulls at top level.
- An explorer (E1) is producing `REPO/audit/slim-2026-08-17/phase2/reports/E1.md` in parallel: a ranked list of heavy subtrees on
  the first-chat graph and candidate lazy seams. Start with step 1 below now; read E1.md when it appears (poll every ~15 min) before
  step 3.

## Do
1. `serverRuntimes/index.ts`: replace the 30 static runtime imports with per-identifier lazy registrations, keeping the public
   API (`getServerRuntimeFactory`/whatever is exported today — check consumers with grep) unchanged. Pattern = the existing
   `messageRuntime` entry: `{ identifier: XIdentifier, factory: async (ctx) => (await import('./x')).xRuntime.factory(ctx) }`.
   Identifiers must come from the light root packages (`@lobechat/builtin-tool-x` root exports `XManifest.identifier` /
   `XIdentifier`) — never from `./x` (that would keep the graph eager). Memoise the dynamic import per identifier (import() is cached by
   the loader anyway; a `Map<identifier, Promise<factory>>` is fine) so concurrent first calls don't double-init pre-instantiated
   runtimes. Preserve the existing `assertToolModuleEnabled` gate order (gate BEFORE import — a disabled module's runtime must not even
   load). Keep registration order/semantics for `has`/`list` style helpers if any exist (if something enumerates identifiers, keep a
   static identifier list).
2. Verify no consumer relies on synchronous factory availability: grep `serverRuntimes` / `getServerRuntime` / `serverRuntimeFactories`
   across apps/server/src, src, packages. Fix call sites in your ownership; note others.
3. First-chat graph: from E1.md take the top seams that are (a) ≥ ~1 MB source or a heavy external, (b) used only on one code path,
   and convert them to `await import()` at the use site — in `aiAgent/index.ts` only import lines + the local call sites (keep diffs
   minimal, one seam = one `await import()`), in your other owned files freely. Do NOT touch the persona/user-settings read region of
   aiAgent/index.ts (G3 owns it). Do NOT change tool semantics; type-only imports may stay static.
4. Tests: `cd REPO && bunx vitest run --silent='passed-only' apps/server/src/services/toolExecution` (memory.test.ts is a known red on
   main — confirm it is the same failure), plus any aiAgent tests you find (`apps/server/src/services/aiAgent/**/*.test.ts`), plus
   `packages/builtin-tools` tests if you touched it. Add a test that asserts the registry resolves every identifier in the static
   list to a factory (async) and that an unknown identifier still returns undefined/throws exactly as before.
5. Static measurement (no build needed): count files/bytes reachable from `serverRuntimes/index.ts` before vs after with a quick
   import scanner (E1 has one in its scratch dir /private/tmp/claude-501/-Users-konata-code-AIHub/9345b506-f4c4-43e9-8306-200ae4e11e70/scratchpad/e1/
   — reuse it if present). Report the delta. (The commander measures RSS on the real Docker image afterwards.)
6. Lint your files: `cd REPO && bun run check --lint <files>`.

Report → REPO/audit/slim-2026-08-17/phase2/reports/G1.md (≤120 lines): files, seams converted (file:line → what), static
reachable-bytes before/after, tests run + results, anything you needed in G3's region.
