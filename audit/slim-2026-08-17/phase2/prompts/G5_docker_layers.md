# G5 — P5: image layering + native-dependency copy convergence (+ ffmpeg gated by the imageGen module)

Read /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/prompts/COMMON_RULES.md first (you are G5).
Then HANDOFF §1 P5: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/HANDOFF.md, and the referenced
`explore/E3_docker.md` (B4/B8/C3/C4 and §D "do not touch"), `reports/G5.md` (phase 1: what was done, the hard-link-through-scratch-COPY
dead end, why `WITH_VIDEO` was reverted), `explore/G0_spike.md` §E (build notes). REPO = /Users/konata/code/AIHub-worktrees/slim2.

## Constraints
- Do NOT change the four-stage structure, the curl-impersonate/cursor-agent download blocks in the `base` stage, `serverExternalPackages`,
  or `dockerCanvasTracingIncludes.ts` semantics (E3 §D). Another session is editing the `base` stage of the Dockerfile in the main tree
  (cursor-agent CLI download) — keep your Dockerfile diff confined to the FINAL stage (and at most the `app` stage copy list) so the
  rebase is trivial.
- `outputFileTracingExcludes` never contains bare `dist/**` (picomatch contains:true would drop next/dist) — the list lives in
  `src/libs/next/config/dockerTracingExcludes.ts`.
- Builds: only from REPO (`cd REPO && docker build --build-arg USE_CN_MIRROR=true -t aihub:p5-<n> .`), first build ~25 min, later
  ~5 min with layer cache. Other agents are editing REPO concurrently — the build context snapshot may include their half-done files;
  if a build fails in `next build` because of someone else's TS error, retry 10 min later, don't fix their code. Never touch containers
  named `aihub-demo-*` / `aihub-dev-*`; do not tag `aihub:demo`. Use `nohup … > log 2>&1 < /dev/null &` and poll the log (long commands
  are killed at 10 min).

## Do
1. Layering: today the final stage does one `COPY --from=app / /` (~944 MB layer). Split into (a) system + `node_modules`
   (`/app/node_modules` incl. `.pnpm`) and (b) the app payload (`.next/standalone` server code, `.next/static`, `public`, `dist/desktop`,
   launcher scripts, `/app/src` remnants) so that a source-only change reuses layer (a). Verify with two consecutive builds where only a
   TS file changed (touch a comment in a fork file): `docker history aihub:p5-2` must show layer (a) CACHED and the same digest as in
   `aihub:p5-1`. If BuildKit's COPY checksum makes (a) non-reproducible between builds (mtimes/ordering), report the reason and the
   best achievable split rather than forcing it.
2. `@napi-rs/canvas` skia.node ×3 (81 MB) and `@img/sharp-libvips` two versions (33 MB): find why three copies are traced
   (`find <image>/app -name 'skia*.node'` and the pnpm paths), converge to one copy while `require.resolve('@napi-rs/canvas')` and
   `require.resolve('sharp')` still work inside the container (test with `docker run --rm --entrypoint node <img> -e "…"`); options in
   order: fix the tracing includes/excludes so only the resolvable path is kept; `pnpm dedupe`-style lockfile change is a LAST resort
   (touching pnpm-lock is upstream-heavy — if that's the only way, report and don't do it).
3. `ffmpeg-static` (49 MB, only used by `apps/server/src/services/generation/video.ts`): gate the import site behind
   `isBootModuleEnabled('imageGen')` (fork guard: `await import('ffmpeg-static')` inside the function that needs it — one-line upstream
   change + a fork helper if needed) so the module can be excluded from the image later; keep the file in the image for now unless
   excluding it is safe (`define-config.ts` mentions it — read why phase 1 reverted `WITH_VIDEO` in reports/G5.md before deciding). Do
   NOT break `imageGen` on the default (full) build.
4. Re-check the image for other >10 MB dead weight (`docker run --rm --entrypoint sh` won't work in distroless — use
   `docker create` + `docker export | tar -tvf` or `docker cp`), e.g. duplicated `@lobehub/icons`, source maps, `.map` files, `.d.ts`,
   test fixtures under `.pnpm`; add them to `dockerTracingExcludes.ts` ONLY if provably unreferenced at runtime (grep the standalone
   `server.js` chunk graph / `require` calls). List what you removed and what you left, with sizes.
5. Runtime verification on the final image (network `aihub-dev_aihub-dev`, DB `lobechat_perf`, Redis db 3, `AUTH_COOKIE_PREFIX=aihub-perf`;
   env values as in phase-1 `reports/V1.md`, secrets in ~/.local/share/aihub/secrets/ — read, never print): boot to Ready, `/api/healthcheck`
   200, PDF parse path (canvas) and image processing (sharp) — call the smallest server code path that requires them (e.g. a node
   one-liner inside the container `require('@napi-rs/canvas')` + `require('sharp')` is the minimum; a real upload e2e is a bonus),
   `platform.getPublicSnapshot` 200. Report image size before/after (`docker images`), layer sizes (`docker history`).

Report → REPO/audit/slim-2026-08-17/phase2/reports/G5.md (≤120 lines): Dockerfile/tracing diff summary, layer table before/after,
what got deduplicated (paths, MB), ffmpeg gate, runtime checks + results, anything for the commander (docs paragraph in
docs/enterprise/modules.md "image" section — you may write it directly).
