# F4 — P4: split the 7.4 MB `es-*` shared vendor chunk + narrow the Service-Worker precache

Read /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/prompts/COMMON_RULES.md first (you are F4).
Then HANDOFF §1 P4: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/HANDOFF.md, and the referenced
`reports/F2.md` (READ IT FULLY: root causes, "Top remaining win" #4, #5, the reverted `vendor-syntax` experiment recorded in
`plugins/vite/sharedRendererConfig.ts` — do not retry it) and `reviews/REVIEW_F2.out.md`. REPO = /Users/konata/code/AIHub-worktrees/slim2.

## Baseline (phase 1, `bun run build:spa` → dist/desktop): blocking first-screen JS ≈22.4 MB / ~137 files; runtime total ≈25.5 MB;
## largest eager chunk `assets/es-*.js` 7.40 MB = `@lobehub/icons` inline SVG (~2.5 MB) + `elkjs` (mermaid ELK layout) + parse5/hast +
## katex fragments + `@pierre/diffs` (own shiki copy). Workbox precaches 1525 entries / 76 MB (VitePWA `globPatterns`).
## Targets: blocking first-screen JS ≤16 MB, runtime total ≤20 MB, precache ≤ first-screen set (tens of MB at most), `plugins/vite/*.test.ts` green.

## Do
1. Measurement harness first (30 min max): a script in your scratch dir (/private/tmp/claude-501/-Users-konata-code-AIHub/9345b506-f4c4-43e9-8306-200ae4e11e70/scratchpad/f4/)
   that, given `dist/desktop`, computes: entry + `<link modulepreload>` set (bytes/files), statically-imported closure of the entry
   (walk `import` specifiers in the built chunks — F2's `analyze.mjs` did this; its scratch dir is gone, rewrite ~60 lines), idle-preload
   set, top-15 chunks with E/D state, and workbox precache manifest size (parse `dist/desktop/sw.js` / `workbox-*.js` or the manifest
   the plugin emits). Run it on a fresh baseline build (`cd REPO && bun run build:spa` — ~1.5 min cold; other agents' edits may make
   the build noisy but the SPA build is independent of server code) and store `before.txt`.
2. `@lobehub/icons`: find why the SVG data is on the entry's static closure (grep the app for `@lobehub/icons` imports reachable
   from the entry/first-screen routes: provider/model icon components in the chat input, model select, sidebar…). Options in order:
   (a) subpath imports (`@lobehub/icons/es/<Icon>` — check the package `exports`) at the few first-screen call sites so tree-shaking
   drops the rest; (b) a dedicated `vendor-icons` chunk that is only *dynamically* imported (React.lazy the icon-heavy components
   that are not first paint); (c) if the icons are genuinely on first paint (model logo in the input bar), keep the smallest set
   static and lazy the rest. Upstream files: `await import()` / `React.lazy` swaps only.
3. `elkjs`, parse5/hast, katex, `@pierre/diffs`: move each to the route/feature chunk that uses it (mermaid render, markdown HTML
   sanitize, math, diff view) via manual chunk groups in `plugins/vite/sharedRendererConfig.ts` AND make sure nothing on the entry
   closure statically imports them (otherwise the group just renames the eager chunk — measure!). If `@lobehub/ui`'s own Markdown
   statically imports something (F2 found `CodeDiff`), you cannot fix it here — record it as an upstream/@lobehub/ui item.
4. Service worker: narrow the VitePWA precache (`vite.config.ts` / the PWA plugin config) to the first-screen set (entry, its static
   closure, fonts/css, manifest, the current locale's i18n) — everything else runtime-cached (StaleWhileRevalidate/CacheFirst
   runtimeCaching rule for `/assets/*` and `/i18n/*`). Keep offline behaviour for the shell. If the PWA config is upstream, keep the
   diff to the `globPatterns`/`globIgnores`/`runtimeCaching` arrays only.
5. Rebuild + re-measure after each lever (≤5 builds total; log build times). Keep only levers that measurably help. Update the
   comment/test in `plugins/vite/*` recording what was measured (F2 left the precedent) so nobody re-tries dead ends.
6. Tests: `cd REPO && bunx vitest run --silent='passed-only' plugins/vite`, any component test near your React.lazy swaps
   (`bun run check --test <files>`), lint your files. Smoke: `bun run dev:spa` is NOT needed; instead serve `dist/desktop` statically
   (`bunx serve dist/desktop -l 5199` or a tiny node static server) and open with Playwright
   (`/Users/konata/code/AIHub/e2e/node_modules/playwright`) to confirm the shell renders without console errors and the SW registers —
   the API calls will fail (no backend) — that is fine for a bundle smoke; if you need a real backend, the phase-1 perf container
   recipe is in `reports/V1.md` (do NOT touch aihub-demo/aihub-dev containers).

Report → REPO/audit/slim-2026-08-17/phase2/reports/F4.md (≤120 lines): before/after table (blocking JS, runtime total, top-15
chunks E/D, precache entries/MB), each lever with its measured delta, upstream files touched (each a one-line swap), dead ends
recorded, tests + smoke results.
