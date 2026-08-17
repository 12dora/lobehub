The sandbox rejected creation of `REVIEW_F2.md` because filesystem writes are disabled. Exact review:

# F2 code review

VERDICT: REWORK

## FINDINGS

1. BLOCKER · `plugins/vite/routeChunkPreload.ts:280`; `src/features/Conversation/Messages/Tasks/shared/InitializingState.tsx:62` · [VERIFIED] These upstream runtime files exceed rule 4's permitted mechanical edits. `routeChunkPreload.ts` adds a new admin predicate/helper even though the existing deferred-module pattern list can express the exclusion as a config entry; `InitializingState.tsx` replaces a simple interval with a 34-line visibility-listener state machine rather than a one-line guard/replacement. Fix: add the admin path to the existing exclusion-pattern configuration and remove `isAdminChunk`; revert the visibility state machine and retain only the minimal active-state guard/replacement required by the brief.

2. MAJOR · `plugins/vite/sharedRendererConfig.ts:135` · [UNVERIFIED] The comment says `vendor-diff` is dynamic-only, but the author report (`F2.md:96-100`) says the built entry still eagerly imports the 0.45 MB chunk through `@lobehub/ui` Markdown/MDX. The report measures blocking first-screen JS at approximately 22.36 MB, above the ≤22 MB target, with a 7.40 MB eager mega-chunk remaining. Fix: remove or lazy-load the remaining static Markdown/MDX-to-`CodeDiff` edge, then rerun a hermetic build until the complete blocking graph—not only HTML preloads—is ≤22 MB.

3. MINOR · `src/features/Conversation/Messages/Tasks/shared/ProcessingState.tsx:165`; `src/features/Conversation/Messages/Tasks/shared/InitializingState.tsx:62`; `src/routes/(main)/memory/features/MemoryAnalysis/useTask.ts:16` · [VERIFIED] Three timer/scheduler branches were changed without regression tests; no corresponding tests exist in those directories. Fix: add fake-timer tests covering inactive/no-`startedAt`, MAX progress, visibility changes and cleanup, one five-second SWR cadence, and polling cessation after a terminal status.

4. MINOR · `src/libs/swr/index.ts:44` · [VERIFIED] The global 0→2000 ms dedupe change affects roughly 489 `useClientDataSWR` references, but the SWR tests do not exercise this hook or the new default. Existing passing tests cannot prove that duplicate mounts collapse while key changes and explicit overrides still revalidate. Fix: test concurrent same-key mounts, immediate changed-key fetches, expiry after two seconds, and preservation of `useOnlyFetchOnceSWR` and caller overrides.

5. MINOR · `audit/slim-2026-08-17/reports/F2.md:5` · [VERIFIED] Deliverable 6 requires before/after top-10 chunks, but the report gives only the largest eager chunk. Fix: add before/after top-10 tables from the raw analyzer output, including eager/dynamic classification.

## METRICS

- Files reviewed: 18—16 tracked diffs and two untracked files read in full.
- Upstream files touched: 18; no fork-owned file is in the F2 diff.
- Rule 4 compliant: `plugins/vite/sharedRendererConfig.ts`, `plugins/vite/sharedRendererConfig.test.ts`, `plugins/vite/routeChunkPreload.test.ts`; `src/components/LazyDiff/{diff.ts,index.tsx}`; the six diff-viewer import call sites; `ProcessingState.tsx`; `useEditLock.ts` and its test; `src/libs/swr/index.ts`; and memory `useTask.ts`.
- Rule 4 noncompliant: `plugins/vite/routeChunkPreload.ts` and `InitializingState.tsx`—new helper/state-machine restructuring.
- Verified checks: `node_modules/.bin/tsgo --noEmit -p tsconfig.json` passed; scoped `git diff --check` passed; scoped tracked and untracked paths were enumerated with `git status --short`.

## UNVERIFIED

- Vitest was not run, per the read-only constraint; the author’s reported 28 + 10 + 71 passing tests remain unverified.
- Production builds, browser request traces, lazy-diff rendering/chunk-load failures, and reported bundle measurements were not independently rerun. The author notes its A/B was non-hermetic.
- No migration, tRPC/module gate, RBAC, error-mapper, or i18n-content files are in F2 scope; those batch rules were not applicable.