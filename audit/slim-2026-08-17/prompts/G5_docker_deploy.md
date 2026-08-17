# G5 — Docker image / compose / runtime knobs / deployment docs

Read ../prompts/COMMON_RULES.md first (ownership: you are **G5**). Then explore/E3_docker.md fully (B1–B9, C, D, E) and
PLAN.md §4/§4b. Work only in /Users/konata/code/AIHub-worktrees/slim. The G0 spike (../explore/G0_spike.md, arrives later)
verifies the tracing excludes on a real `next build` — read it if present before finalizing item 1.

## Deliverables
1. **Tracing excludes for Docker** — `next.config.ts` (upstream): generalize the existing `isVercel ? vercelConfig : {}` into
   `isVercel ? vercelConfig : isDocker ? dockerConfig : {}` where `dockerConfig.outputFileTracingExcludes['*']` lists ONLY the
   100%-safe items: `./dist/**`, `./apps/desktop/**`, `./apps/cli/**`, `./e2e/**`, `./tests/**`, `./**/*.tsbuildinfo`,
   `./packages/database/migrations/**` (Dockerfile copies them separately — verify `Dockerfile:157`), `./changelog/**`,
   `./docker-compose/**`. Do NOT exclude `/app/src`, `/app/packages`, `/app/apps/server` (mechanism unclear, E3 E1). And in
   `src/libs/next/config/define-config.ts:44-45` delete the two `dist/desktop/**` / `dist/mobile/**` INCLUDE lines whose comment
   says the opposite (keep `public/_spa/**` and migrations include if runtime needs them — check `scripts/copySpaBuild.mts`).
2. **Dockerfile** (fork-modified upstream file; keep the 4-stage structure, curl-impersonate stage, serverExternalPackages,
   canvas tracing includes untouched — E3 D1–D4): add build ARGs `WITH_VIDEO=1` (ffmpeg-static) — when `0`, remove
   `ffmpeg-static` from the final tree (or add to excludes) — and de-duplicate `@napi-rs/canvas` skia.node ×3 / sharp-libvips
   ×2 / `@vitejs/devtools` ×4 ONLY if you can do it with a safe `find`/prune step in the busybox stage that keeps the copy the
   runtime resolves (verify with a real `require.resolve` inside a throwaway container). Add
   `NODE_OPTIONS` default heap cap via `LOBE_NODE_HEAP_MB` (env at runtime, default 1536) — since Dockerfile bakes `NODE_OPTIONS`,
   implement it in `scripts/serverLauncher/startServer.js` (see 3) rather than the image ENV. Optional (only if trivially safe):
   split the final `COPY --from=app / /` into two layers (system+node_modules vs app) — E3 C4.
3. **`scripts/serverLauncher/startServer.js`** (upstream, 3 small guards): `SKIP_DB_MIGRATION=1` skips `/app/docker.cjs`;
   `ENABLE_BOT_GATEWAY=0` (or `LOBE_MODULES_DISABLED`/preset containing `bots` — reuse the pure resolver? it's TS in
   packages/const; do NOT import it from this CJS launcher; just honour `ENABLE_BOT_GATEWAY` and document that G2's handler also
   no-ops when the bots module is off) skips `startGateway()`; heap cap: if `LOBE_NODE_HEAP_MB` is set (or default 1536), append
   `--max-old-space-size=<n>` to the child `NODE_OPTIONS` (don't clobber existing flags). Keep the file's style; add nothing else.
4. **Compose** `docker-compose/enhanced/docker-compose.yml` + `.env.example`: profiles `redis`, `s3`, `search`
   (add a searxng service under `search` profile mirroring `docker-compose/deploy`), `depends_on` with `required: false`
   where the Compose spec allows (verify version), S3 `:?` hard check moved so `minimal` boots without S3 (app must tolerate
   empty S3 env — check `packages/env/src/file.ts` behaviour and the app's `enableUploadFileToServer` fallback), new vars
   `LOBE_MODULE_PRESET` (default full), `LOBE_MODULES_DISABLED`, `LOBE_NODE_HEAP_MB`, `ENABLE_BOT_GATEWAY`, `SKIP_DB_MIGRATION`,
   optional `mem_limit`/`cpus` commented examples per tier. Three documented ways to start:
   `docker compose up -d` (full = today), `--profile redis --profile s3` (standard), none (minimal). Root `.env.example`: same vars.
5. **Docs**: create `docs/enterprise/modules.md` (English) with sections: Overview (what a module is; default all-on), the module
   table (copy ids/tiers/kind/cost meaning from packages/const/src/platform/modules.ts — generate the table from the file so it
   can't drift), Presets & sizing (minimal 1–2C/2–4G, standard 2–4C/4–8G, full 4C/8G+, with heap recommendations 1024/1536/2048),
   Env reference, Compose profiles, "What each disabled module hides / returns" (FORBIDDEN PLATFORM_MODULE_DISABLED), Restart
   semantics (`kind: restart`, supervisor mode = self SIGTERM + compose `restart: always`), Image size notes, and two markers
   `<!-- G1: storage & API -->` `<!-- F1: admin page -->` for the commander. Link it from `docs/enterprise/README.md` and add a
   short "Module presets / smaller deployments" paragraph to `docker-compose/enhanced/README.md` and the root README's enhanced
   section (Chinese README.md is the primary; keep it brief).
6. **Verification (real build, mandatory)**: use the clean detached worktree /Users/konata/code/AIHub-build-np (no node_modules;
   Docker builds only). Copy ONLY your changed files there (`next.config.ts`, `src/libs/next/config/define-config.ts`,
   `Dockerfile`, `scripts/serverLauncher/startServer.js`), then `cd /Users/konata/code/AIHub-build-np && docker build --build-arg
   USE_CN_MIRROR=true -t aihub:slim-g5 .` (takes ~20–30 min; run with nohup + log). Then measure like E3 did: `docker history`,
   `du` of /app/dist /app/apps /app/src /app/.next, and boot the image against the perf DB:
   `docker run --rm -d --name aihub-slim-g5 --network aihub-dev_aihub-dev --env-file /Users/konata/code/AIHub/.env.development
   --env-file ~/.local/share/aihub/demo/.env.platform -e DATABASE_URL=postgresql://postgres:change_this_password_on_production@aihub-dev-postgres:5432/lobechat_perf
   -e REDIS_URL=redis://aihub-dev-redis:6379/3 -e AUTH_COOKIE_PREFIX=aihub-perf -e APP_URL=http://localhost:3021 -e PORT=3210
   -p 127.0.0.1:3021:3210 <the ENABLE_* and other -e from ~/.local/share/aihub/demo/docker-compose.app.yml> aihub:slim-g5`,
   check `/` and `/admin` return 302/200, migration passes, `LOBE_NODE_HEAP_MB` shows up in the child's NODE_OPTIONS
   (`docker exec ... cat /proc/<next-server pid>/environ`), then remove the container. Report sizes before/after (E3 baseline
   1.72GB image / 1.25GiB /app / dist 270MiB).

Report ../reports/G5.md with the size table, the compose usage matrix, and anything you could not verify.
