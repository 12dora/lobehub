The sandbox blocked creation of `REVIEW_G5.md` because it is read-only. Here is the requested review:

# G5 Code Review

## VERDICT: REWORK

REWORK because the diff contains BLOCKER findings.

## FINDINGS

1. **BLOCKER** · `scripts/serverLauncher/startServer.js:121` · **[verified]** An absent or empty `LOBE_NODE_HEAP_MB` becomes `1536`, so every unconfigured image injects `--max-old-space-size=1536` into migration and server children. This violates COMMON_RULES 5 and can cause V8 OOM/restart loops. Only append the flag when explicitly configured; let Compose opt into `1536`.

2. **BLOCKER** · `docker-compose/enhanced/docker-compose.yml:142` · **[verified]** Redis and rustfs, previously ordinary services, are now profile-gated. With no `COMPOSE_PROFILES`, Compose returns only `platform-oidc-lkg-init`, `postgresql`, and `lobehub`; existing installations upgrading with their old `.env` silently lose Redis/S3 while retaining their URLs. Preserve the legacy full stack when the variable is absent and test the upgrade/no-new-variable case.

3. **BLOCKER** · `next.config.ts:24` · **[verified]** Rule 4 is not obeyed: a substantial Docker tracing catalog is implemented inline; `Dockerfile:74`, `scripts/serverLauncher/startServer.js:116`, and the new upstream test also add multi-line fork logic/control-flow restructuring. The test is also outside G5’s owned set. Move helpers and tests under a permitted fork-owned path and leave only mechanical imports/guards upstream.

4. **MAJOR** · `Dockerfile:188` · **[verified]** `WITH_VIDEO=0` deletes `ffmpeg-static`, but video routers remain enabled and `VideoGenerationService` still calls `require('ffmpeg-static')`. Requests therefore fail with `MODULE_NOT_FOUND`, not the stable disabled contract. Keep ffmpeg until a supported gate exists, or gate/hide video and add a `WITH_VIDEO=0` request test.

5. **MAJOR** · `docs/enterprise/modules.md:188` · **[verified]** The documented tRPC error envelope is incompatible with the client mapper. The mapper reads `data.errorData.code` and `data.errorData.details.moduleId`; the documentation shows `message: PLATFORM_MODULE_DISABLED` plus `data.moduleId`. Document the actual tRPC shape and separately document the Hono `{ error, moduleId }` response.

6. **MAJOR** · `src/libs/next/config/dockerTracingExcludes.test.ts:9` · **[verified]** The test duplicates the exclude patterns rather than evaluating production configuration. It remains green if `next.config.ts` regresses to the build-breaking bare `dist/**` glob, and it omits conditional ffmpeg patterns. Export one canonical builder and use it in production and tests.

7. **MINOR** · `docs/enterprise/modules.md:263` · **[verified]** The documentation says canvas binaries are hard-linked, while `Dockerfile:178-181` explicitly says hard-linking was skipped. Correct the image-size notes.

## METRICS

- Files reviewed: **14** — 10 tracked modifications and 4 untracked files; `searxng-settings.yml` is byte-identical to the deploy version.
- Upstream files touched:
  - `.env.example` — **obeys rule 4**: targeted env entries/comments.
  - `Dockerfile` — **does not obey rule 4**: multi-line build/prune logic.
  - `README.md` — **obeys rule 4**: short documentation insertion.
  - `next.config.ts` — **does not obey rule 4**: inline Docker catalog.
  - `scripts/serverLauncher/startServer.js` — **does not obey rule 4**: helper and control-flow restructuring.
  - `src/libs/next/config/define-config.ts` — **obeys rule 4**: targeted deletions/replacement.
  - `src/libs/next/config/dockerTracingExcludes.test.ts` — **does not obey rule 4/ownership**: new upstream file outside the assigned set.

## UNVERIFIED

- Vitest was not run due to the read-only sandbox.
- `tsgo --noEmit` did not complete in the available window; TypeScript status is unverified. `node --check scripts/serverLauncher/startServer.js` passed.
- The reported Docker build, boot, and size measurements were not independently reproduced.
- `WITH_VIDEO=0`, `SKIP_DB_MIGRATION=1`, and `ENABLE_BOT_GATEWAY=0` were not live-tested.
- Compose expansion was verified with no profiles and with `redis,s3,search`; service health was not tested.