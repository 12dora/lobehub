# VERDICT: REWORK

## FINDINGS

1. **BLOCKER** · `packages/memory-user-memory/src/services/extractExecutor.ts:366` · **[verified]** Five pre-existing union assertions were reformatted at lines 366–387. This upstream file may not receive unrelated reformatting under batch rule 2; the author’s report also confirms the formatter caused it. Restore the original multiline union formatting while retaining the lazy-import changes.

2. **MINOR** · `packages/memory-user-memory/src/services/extractExecutor.ts:50` · **[verified]** No test directly exercises `MemoryExtractionService` after metrics recording became asynchronous. Existing package tests cover extractors, schemas, and providers only. A regression in first-import handling, success/error propagation, or per-layer error isolation would therefore go undetected. Add a focused `extractExecutor.test.ts` with mocked OTel modules covering success, gatekeeper failure, concurrent layers, and one-layer failure isolation.

3. **MINOR** · `packages/agent-tracing/package.json:9` · **[verified]** No test validates the new `./viewer` package export or prevents the root barrel from regaining the viewer/`gpt-tokenizer` edge. Current viewer tests use relative imports, so a broken export map would still pass. Add an export-resolution/API test and a static boundary assertion for the root barrel.

## METRICS

- Files reviewed: **4 modified, 0 untracked**
- Upstream files touched:
  - `packages/agent-tracing/src/index.ts` — **obeys rule 2**; mechanical removal of the requested re-export.
  - `packages/agent-tracing/package.json` — **obeys rule 2**; one export-map entry added.
  - `packages/memory-user-memory/src/services/extractExecutor.ts` — **does not obey rule 2** because of unrelated reformatting; the lazy-import plumbing itself is mechanical.
- Fork file:
  - `apps/server/src/enterprise/services/skillCatalog/validator.ts` — one-line light-subpath replacement; compliant.

## UNVERIFIED

- Vitest was not run in the read-only review sandbox; the author-reported passing tests remain unverified.
- `tsgo --noEmit` was not run; type correctness was inspected statically only.
- The reported E1 scanner deltas (`−47` files, `−264k`, `−4` externals) were not independently reproduced.