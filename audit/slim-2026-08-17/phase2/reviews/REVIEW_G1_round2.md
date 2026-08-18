# VERDICT: REWORK

## FINDINGS

1. **BLOCKER · `packages/builtin-tool-remote-device/src/types.ts:1` · [VERIFIED—static]** The change relocates the 31-line `DeviceChannel`, `DeviceScope`, and `DeviceAttachment` declarations into this upstream file. This is restructuring, which violates mandatory batch rule 2; it is also unnecessary for laziness because a proper `import type` is erased from the runtime graph. Restore the declarations to their original canonical file and keep only `import type { DeviceAttachment } from './ExecutionRuntime/types'` here and at type-only consumers.

Round 1 findings #1–#3 are otherwise closed:

- All 29 `./manifest` exports resolve, and a static traversal found no execution-runtime, executor, or client files reachable from them.
- Registry traversal reproduced **500 files / 2,040,289 bytes**, with zero runtime implementations eagerly reachable.
- `task.ts` now derives `TaskCaller` through a type-only router import; the hand-written shim and casts are gone.
- The registry test mocks all 32 runtime modules, resolves every identifier, and exercises a fresh deferred concurrent initialization.

## METRICS

Files reviewed: **59** — 57 tracked modifications plus 2 untracked files. The specified persona-read region of `services/aiAgent/index.ts` was excluded.

Upstream files touched: **58**.

| Upstream files | Rule 2 |
|---|---|
| `apps/server/src/routers/lambda/aiAgent.ts` | Obeys — local `await import()` swaps and removal of the corresponding eager construction |
| `apps/server/src/services/aiAgent/{deviceToolRegistry,index}.ts` | Obeys in G1 regions — import replacements and local lazy call sites |
| `apps/server/src/services/toolExecution/serverRuntimes/{calculator,index,task}.ts` | Obeys — import replacements, permitted registry wrapper/memo, and lazy imports |
| `apps/server/src/services/toolExecution/serverRuntimes/__tests__/registry.test.ts` | Obeys — the brief explicitly required this new regression test |
| `packages/builtin-tool-{activator,agent-builder,agent-documents,agent-management,agent-signal,brief,calculator,cloud-sandbox,creds,group-management,knowledge-base,lobe-agent,lobe-delivery-checker,local-system,memory,message,notebook,page-agent,remote-device,self-iteration,skill-maintainer,skill-store,skills,task,topic-reference,user-interaction,verify,web-browsing,web-onboarding}/package.json` | Obey — mechanical subpath-export additions |
| `packages/builtin-tool-{activator,agent-builder,agent-documents,agent-signal,calculator,knowledge-base,lobe-agent,lobe-delivery-checker,local-system,message,notebook,page-agent,remote-device,self-iteration,skill-maintainer,skill-store,skills,topic-reference,user-interaction,web-onboarding}/src/manifest.ts` | Obey — one-line identifier re-exports or the requested export-only agent-signal manifest |
| `packages/builtin-tool-calculator/src/index.ts` | Obeys — one-line execution-runtime export removal |
| `packages/builtin-tool-remote-device/src/types.ts` | **Violates** — upstream type relocation/restructuring |

`apps/server/src/enterprise/guards/toolModuleGate.ts` is fork-owned and not subject to rule 2; its import-only changes are correct.

No router/procedure or registry-count changes were found. The tool-module gate remains before every runtime import, and concurrent first calls share the pending factory promise.

## UNVERIFIED

- Vitest was not run because the sandbox is read-only; the author-reported results remain unverified.
- Lint was not run because the prescribed command auto-fixes files.
- `bunx tsgo --noEmit --incremental false -p tsconfig.json` surfaced no G1 errors, but exited with three unrelated existing errors in `platform.job.test.ts` and `src/components/mdx/Image.tsx`; a fully clean type-check is therefore unverified.
- Runtime RSS impact was not independently measured.