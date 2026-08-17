# G5b — Rework after review (Docker / compose / launcher / docs)

Same tree /Users/konata/code/AIHub-worktrees/slim, you are still G5. Absolute paths:
- Rules: audit/slim-2026-08-17/prompts/COMMON_RULES.md
- Your brief/report: …/scratchpad/slim/prompts/G5_docker_deploy.md, …/scratchpad/slim/reports/G5.md
- Review: audit/slim-2026-08-17/reviews/REVIEW_G5.out.md
- Spike facts: …/scratchpad/slim/explore/G0_spike.md §D (root cause of `/app/src` + `/app/packages` in the image = whole-project
  tracing triggered by an opaque `path.resolve(process.cwd(), <const>)` in `apps/server/src/enterprise/services/networkProxy/engine/platform.ts`;
  the commander already replaced it with literal segments) and …/explore/G0b_measure.md (if present).

Adjudication (do exactly this):
1. ACCEPT F1 (BLOCKER): `startServer.js` must NOT inject a heap cap when `LOBE_NODE_HEAP_MB` is unset (default = today's behaviour).
   Only append `--max-old-space-size` when the variable is explicitly set (and `0` disables). Put `LOBE_NODE_HEAP_MB=1536` as the
   *documented default* in `docker-compose/enhanced/docker-compose.yml` `environment` (fork file) with a comment, so new compose users
   get the cap while raw `docker run` users are unchanged.
2. ACCEPT F2 (BLOCKER): no regression for existing compose users. Redis and rustfs (+ rustfs-init) go back to being plain always-on
   services in `docker-compose/enhanced/docker-compose.yml`; ONLY searxng keeps `profiles: [search]` (it never existed in this file
   before, so opt-in is not a regression). Provide the smaller stack as a separate file `docker-compose/enhanced/docker-compose.minimal.yml`
   (app + postgres + lkg-init; no redis/s3; documented `docker compose -f docker-compose.minimal.yml up -d`) — verify with
   `docker compose -f … config --services`. Update `.env.example` (`COMPOSE_PROFILES` only for `search`), README paragraphs and docs.
3. ACCEPT F3 (BLOCKER, rule 4): move the Docker tracing-exclude list into a canonical builder module next to the existing
   `dockerCanvasTracingIncludes.ts` — `src/libs/next/config/dockerTracingExcludes.ts` exporting `dockerTracingExcludes(): string[]`
   (this file becomes the ONE source used by `next.config.ts` (one import + one line) and by the test — fixes F6 too). Keep the
   `startServer.js` change to the smallest possible form (three `if` guards, tiny helper for NODE_OPTIONS append). Keep the
   `Dockerfile` change minimal (F4 below removes most of it). The upstream test file may stay only if it imports the canonical builder.
4. ACCEPT F4 (MAJOR): drop `WITH_VIDEO` and the ffmpeg prune entirely this round (video would fail with MODULE_NOT_FOUND). Keep only
   the `@vitejs/devtools` prune if it is a one-liner and verified safe; otherwise drop it too.
5. ACCEPT F5 (MAJOR): fix docs/enterprise/modules.md to the ACTUAL tRPC error envelope: read `apps/server/src/enterprise/guards/enterpriseErrors.ts`
   and `src/enterprise/client/errors/mapEnterpriseError.ts` — it is `code: FORBIDDEN`, `data.errorData.code = 'PLATFORM_MODULE_DISABLED'`,
   `data.errorData.details.moduleId`; and document the Hono webapi shape separately (`{ error: 'PLATFORM_MODULE_DISABLED', moduleId }`, 403).
6. ACCEPT F7 (MINOR): fix the canvas hard-link note.
7. `src/`/`packages/`/`apps/server` in the image: with the commander's `platform.ts` fix, verify on the next real build whether they
   disappear from `.next/standalone`; if they still appear, find the remaining "Dynamic filesystem access causes tracing of the whole
   project" warnings in the build log (`next build` prints them) and report file:line — do NOT add `src/**` to excludes blindly.
8. Rebuild + boot verification exactly like round 1 (build box /Users/konata/code/AIHub-build-np — copy ONLY your changed files there
   plus the two commander files `apps/server/src/enterprise/services/networkProxy/engine/platform.ts` and
   `apps/server/src/enterprise/routers/moduleRouter.ts`? NO — the build box must reflect the whole branch to be meaningful; instead
   wait: the commander will commit round 2 and tell you the commit; if that message has not arrived when you finish the code, run the
   build from a fresh detached worktree of the slim branch's working tree copy: `rsync -a --exclude node_modules --exclude .next
   --exclude dist /Users/konata/code/AIHub-worktrees/slim/ /Users/konata/code/AIHub-build-np/` (build-np is a throwaway build tree)
   then `docker build --build-arg USE_CN_MIRROR=true -t aihub:slim-r2 .` (nohup + log), then measure sizes and boot against the perf
   DB as before, PLUS: `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3021/trpc/lambda/platform.getPublicSnapshot`
   style checks that a lambda tRPC call is not 500 (G0 saw 500s when nested deps got pruned), and check `docker exec … ls /app/src` to
   see whether the source tree is still traced in.
9. Append "Round 2" to …/scratchpad/slim/reports/G5.md with the new size table and the compose matrix. Final message: 10 lines.
