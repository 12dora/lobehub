# G1b — rework after codex review (REVIEW_G1.md). Same tree, you are still G1.

Review: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/reviews/REVIEW_G1.md — read it fully.
Commander verdicts — all three accepted, with the approach for #1 fixed below:

1. (BLOCKER 1) Roots that still re-export execution code (agent-documents, cloud-sandbox, creds, lobe-agent, remote-device,
   self-iteration, skill-maintainer, user-interaction, agent-signal, …): do NOT reshape those roots (client code imports them widely).
   Instead give each such package a light `./manifest` subpath export (`"./manifest": "./src/manifest.ts"` — or whatever file holds
   the manifest/identifier without importing runtime; if the manifest file itself imports the runtime, split the identifier/manifest
   into a light file first, one package at a time) and import identifiers/manifests from `@lobechat/builtin-tool-x/manifest` in
   `serverRuntimes/index.ts` AND in `apps/server/src/services/aiAgent/index.ts` (the top-level imports at lines ~10–21 — including
   `remote-device` at line 16, so the `await import()` at ~3403 becomes effective; `generateSystemPrompt` from a `./systemRole`-style
   subpath or the same lazy import). Verify with the E1 scanner that none of those packages' ExecutionRuntime/client trees are on the
   `serverRuntimes/index.ts` root graph or the aiAgent root graph any more; put the before/after numbers in the report. Keep the
   `packages/builtin-tools/src/index.ts` (client manifest catalogue) untouched.
2. (BLOCKER 2) `serverRuntimes/task.ts`: drop the hand-written `TaskCaller` interface and casts; keep the router-derived type via a
   type-only import (`import type { taskRouter } from '@/server/routers/lambda/task'` + `ReturnType<typeof taskRouter.createCaller>` or
   the `Awaited<ReturnType<...>>` shape you need) so the only runtime change is the `await import()`. Must type-check under strict.
3. (MAJOR 3) `registry.test.ts`: mock the runtime modules and assert every registered identifier resolves to a factory; test concurrent
   first initialisation with a fresh deferred loader (assert one initialisation).

Then rerun the toolExecution/aiAgent tests you ran before + `bunx tsgo --noEmit -p tsconfig.json` ONCE (grep your files). Update
`phase2/reports/G1.md` with a "Round 2" section (per finding, packages given a `./manifest` subpath, scanner numbers, tests).
Final message: 8 lines.
