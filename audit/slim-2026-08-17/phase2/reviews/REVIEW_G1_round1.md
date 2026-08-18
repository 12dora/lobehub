# VERDICT: REWORK

## FINDINGS

1. **BLOCKER · `apps/server/src/services/toolExecution/serverRuntimes/index.ts:15` · [VERIFIED—static]** Several newly imported “light” roots still re-export execution code: agent-documents, cloud-sandbox, creds, lobe-agent, remote-device, self-iteration, skill-maintainer, user-interaction, and agent-signal. E1 measured 663 kB for creds, 255 kB for agent-documents, and 245 kB for lobe-agent alone. Consequently, their runtimes remain in the eager graph, violating lazy-seam rule 6. The remote-device import at `aiAgent/index.ts:3403` is also ineffective because that same root is already statically imported at line 16. Make these roots metadata-only, expose runtime/system-role implementations through explicit subpath exports, and dynamically import those subpaths.

2. **BLOCKER · `apps/server/src/services/toolExecution/serverRuntimes/task.ts:27` · [VERIFIED—static]** The hand-written `TaskCaller` contract does not type-check under the repository’s strict configuration: `list` and `updateStatus` return `unknown`, but their results are dereferenced at lines 397 and 671; `addComment.data` is optional but dereferenced at line 197. The 12-line parallel interface and casts at lines 752/767 also exceed rule 2’s permitted mechanical `await import()` swap. Preserve the router-derived type with a type-only import or `ReturnType<(typeof import(...))['taskRouter']['createCaller']>`, then remove the shim and casts.

3. **MAJOR · `apps/server/src/services/toolExecution/serverRuntimes/__tests__/registry.test.ts:117` · [VERIFIED—static]** The test claiming every identifier resolves to an async factory only checks `hasServerRuntime` for each identifier and resolves Calculator alone. The concurrency test at line 146 also reuses Calculator after lines 127/133 have already warmed its cache, so it never exercises concurrent first initialization. Mock the runtime modules and resolve every registration; test concurrency with a fresh, deferred loader and assert one initialization.

## METRICS

Files reviewed: **8** — 7 tracked modifications plus 1 untracked test. The G3 persona-read region in `services/aiAgent/index.ts` was excluded.

| Upstream file touched | Rule 2 |
|---|---|
| `apps/server/src/routers/lambda/aiAgent.ts` | Obeys — import removal and local `await import()` swaps |
| `apps/server/src/services/aiAgent/index.ts` | Obeys in G1 regions — import/type-only changes and local `await import()` swaps |
| `apps/server/src/services/toolExecution/serverRuntimes/calculator.ts` | Obeys — one import replacement |
| `apps/server/src/services/toolExecution/serverRuntimes/index.ts` | Obeys structurally — wrapper memo plus mechanical lazy registrations; rule 6 still fails |
| `apps/server/src/services/toolExecution/serverRuntimes/task.ts` | **Does not obey** — new parallel interface and casts |
| `apps/server/src/services/toolExecution/serverRuntimes/__tests__/registry.test.ts` | Obeys — brief explicitly requires the new test |
| `packages/builtin-tool-calculator/src/index.ts` | Obeys — one-line export removal |
| `packages/builtin-tool-calculator/package.json` | Obeys — one-line subpath export |

## UNVERIFIED

- Vitest was not run, per the read-only sandbox constraint; all author-reported test results remain unverified.
- No clean full type-check completed: one run encountered unrelated workspace errors and a blocked `.tsbuildinfo` write; a read-only filtered run did not finish.
- Lint could not be run because the prescribed command auto-fixes files.
- The reported static reachable-byte reduction and Docker RSS impact were not independently reproduced.