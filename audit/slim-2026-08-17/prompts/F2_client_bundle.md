# F2 — First-screen bundle & client timers (33.8MB → ≤22MB target)

Read ../prompts/COMMON_RULES.md first (ownership: you are **F2**). Then explore/E5_request_path.md §B1/B2/B5/C (rows 1-3, 8, and
the "补充" list). Work only in /Users/konata/code/AIHub-worktrees/slim. Everything here is upstream code — keep each change
minimal and mechanical (config entries, `lazy()`, a guard in an effect, one default value). No behaviour changes visible to users
except faster loads.

Measured (E5): chat home cold load = 423 JS files / 33.8MB uncompressed; `assets/es-CAULdSB8.js` 8.1MB = Shiki full-language
dep-map loaded on first screen; i18n downloads `i18n-src` 2.4MB + en-US 0.96 + zh-CN 0.91 + **ar 0.91MB** (index.html preloads
`i18n-ar`); `ErrorContent` 1.23MB and `TagCloudCanvas` 1.01MB loaded eagerly; SWR `dedupingInterval: 0`
(`src/libs/swr/index.ts:28`) → `config.getGlobalConfig` ×2, `aiProvider.getAiProviderRuntimeState` ×3 per load.

## Deliverables
1. **Shiki**: locate the import that pulls the full `shiki` bundle (likely via `@lobehub/ui` Highlighter / `Markdown` or a direct
   `shiki` import in src). Preferred fix in priority: (a) if the code already picks languages, restrict `bundledLanguages` to a
   curated set (~40 common languages) or switch to `shiki/core` + on-demand language loading if the API used allows; (b) otherwise
   ensure it is not on the first-screen path (make the consuming component `lazy()`/dynamic so the 8MB chunk loads when a code
   block is first rendered); (c) at minimum move it into its own vite manualChunk so it is not part of any first-screen chunk.
   Measure with `bun run build:spa:raw` (or the desktop entry build only) and `ls -la dist/desktop/assets | sort -k5 -n | tail`.
2. **i18n**: stop preloading/loading locales other than the active one. Check `index.html` / `scripts/generateSpaTemplates.mts`
   modulepreload of `i18n-ar` and the i18n init (`packages/locales/src/create.ts`, `src/utils/i18n/**`): the fallback chain should
   load `en-US` only when the active language is not en-US and only for missing keys; `i18n-src` (default resources) 2.4MB —
   check whether it must be on the critical path or can be replaced by the built per-language bundles. Do not remove `en-US`
   static fallback (E3 D5). Measure request list before/after with a quick Playwright script against `bun run dev:spa`
   (or the built preview) — reuse ../explore/e5_raw/measure*.mjs.
3. **Lazy first-screen chunks**: `ErrorContent` and `TagCloudCanvas` (find their import sites on the chat home path) → `React.lazy`
   with a lightweight fallback; look for 1–3 more >500KB first-screen chunks in the E5 list that are not needed at first paint.
4. **Timers**: `src/features/Conversation/Messages/Tasks/shared/ProcessingState.tsx:~163` and `InitializingState.tsx:~63`
   (`useEffect(...,[])` intervals without state guard) → only run while the state is active; `src/routes/(main)/memory/features/MemoryAnalysis/useTask.ts`
   remove the redundant 5s `setInterval mutate` next to the 30s SWR refresh; `src/features/EditLock/useEditLock.ts:~166` viewer peek
   10s → 60s for read-only viewers (mirror `useDocumentLock.ts:93`). Tests where they exist.
5. **SWR**: `src/libs/swr/index.ts` `dedupingInterval` 0 → 2000 for `useClientDataSWR` (check the other two helpers there and keep
   `useOnlyFetchOnceSWR` semantics). Verify no test relies on 0.
6. Report before/after numbers: total first-screen JS bytes & file count for chat home (desktop), top-10 chunks, and the i18n set.

Report ../reports/F2.md. Do not touch server code, `src/enterprise/**` or locale JSON content.
