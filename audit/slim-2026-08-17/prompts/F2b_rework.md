# F2b — Rework after review (first-screen bundle & timers)

Same tree /Users/konata/code/AIHub-worktrees/slim, you are still F2. Absolute paths:
- Rules: audit/slim-2026-08-17/prompts/COMMON_RULES.md
- Your brief/report: …/scratchpad/slim/prompts/F2_client_bundle.md, …/scratchpad/slim/reports/F2.md
- Review: audit/slim-2026-08-17/reviews/REVIEW_F2.out.md

Adjudication (do exactly this):
1. ACCEPT F1 (rule 4): (a) `plugins/vite/routeChunkPreload.ts` — express the admin-chunk exclusion through the EXISTING deferred/
   exclusion pattern list (a config entry), remove the new `isAdminChunk` helper. (b) `InitializingState.tsx` — revert the
   visibility-listener state machine; keep only the minimal "run the 1s timer while the state is active" guard (a few lines).
2. ACCEPT F2 (MAJOR): the remaining eager edge `@lobehub/ui` Markdown/MDX → `CodeDiff` (`vendor-diff` 0.45 MB) — try to lazy-load
   the diff renderer at the Markdown component boundary (a `React.lazy` wrapper for the code-diff renderer where Markdown maps it,
   inside our code, not by patching @lobehub/ui). If it can only be done by patching the package, leave it and document. Then rerun ONE
   hermetic build and report the blocking first-screen JS (target ≤22 MB) with a before/after top-10 chunk table (eager/dynamic).
3. ACCEPT F3 (MINOR): fake-timer tests for `ProcessingState` (inactive / no startedAt / MAX progress / cleanup), `InitializingState`
   (active guard + cleanup) and memory `useTask` (single cadence; stops on terminal status).
4. ACCEPT F4 (MINOR): a small test for `useClientDataSWR` dedupe (two mounts same key ⇒ one fetch; changed key ⇒ fetch; caller
   override honoured; `useOnlyFetchOnceSWR` unchanged).
5. Note: the commander wrapped `src/enterprise/client/providers/EnterprisePlatformProvider.test.tsx` renders in a fresh `SWRConfig`
   provider because of the 2000 ms dedupe — keep.
6. Verify (`bun run .agents/scripts/check/cli.ts --lint --test <files>` + targeted vitest), append "Round 2" to
   …/scratchpad/slim/reports/F2.md. Final message: 10 lines with the numbers.
