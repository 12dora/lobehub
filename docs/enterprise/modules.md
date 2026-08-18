# Platform modules

How to run a smaller LobeHub Enhanced deployment: what a _module_ is, which
preset to pick, which Compose profiles to turn on, and what happens when a
module is off.

The id / tier / kind / cost columns in the table below are generated from
[`packages/const/src/platform/modules.ts`](../../packages/const/src/platform/modules.ts)
(`bun docs/enterprise/generate-modules-table.mts`). Do not hand-edit the table.

## Overview

A **module** is a coarse feature area (knowledge base, bots, audit, …) that an
operator may leave out of a deployment to save memory, CPU, or sidecars.

- Every module defaults **ON**. An unconfigured deployment behaves exactly like
  today's image.
- env can only **disable**. A missing database row also means everything on.
- Effective rule:
  `effective[id] = envDisabled ? false : (dbRow?.modules[id] ?? true)`.
- tRPC routers are always mounted. A disabled module answers
  `PLATFORM_MODULE_DISABLED` (tRPC `FORBIDDEN`, `data.moduleId`), never
  `NOT_FOUND`.
- `kind: hot` takes effect on the next page load. `kind: restart` owns
  boot-time workers / subprocesses / the bot gateway; toggling it is pending
  until the process restarts.

## Storage & API

- **Storage**: singleton row `platform_module_settings` (`id='global'`, jsonb `modules`
  \= partial `{ [moduleId]: boolean }`, `setup_completed_at`, CAS `revision`, `updated_by`);
  migration `0020_platform_module_settings`. A missing row means "everything enabled".
- **Resolution** (`apps/server/src/enterprise/services/moduleSettings`):
  `effective[id] = envDisabled ? false : (db.modules[id] ?? true)` where the env layer is
  `LOBE_MODULE_PRESET` + `LOBE_MODULES_DISABLED` + legacy `ENABLE_PLATFORM_*=0`
  (`packages/const/src/platform/modules.ts`).
  - _Hot view_ (`getModuleSettingsSnapshot()` / `isModuleEnabled()`): 30 s `DomainConfigCache`
    - Redis scope `modules` for cross-instance invalidation; used by every request-time gate.
  - _Boot view_ (`initBootModules()` / `getBootModules()`): resolved once at the start of
    `instrumentation.register()` and frozen for the process; used by the worker registry,
    the bot gateway, the mihomo supervisor and the moderation / egress wrappers.
- **Gates**: `enterprise/guards/platformPermission.ts` (every `admin.*` procedure, by router
  key), `guards/moduleGuard.ts` (`platform.*` user-facing sub-routers),
  `enterprise/routers/moduleRouter.ts` (upstream sub-routers, tRPC `lazy()`),
  `guards/webapiModuleGate.ts` (Hono `/api/agent`, `/api/workflows`),
  `enterprise/bootstrap/workersBootstrap.ts` (workers), and the FEATURE\_FLAGS derivation
  (`services/moduleSettings/featureFlagOverrides.ts`) that hides upstream UI.
- **API** (`admin.modules.*`, registered in both policy registries):
  - `get` (`SYSTEM_READ`) → `{ snapshot, pendingRestart, restart: { supported, reason? }, instanceId }`
  - `update` (`SYSTEM_OPERATE`; re-auth when turning off `audit` / `moderation`; audit action
    `admin.modules.update`) — input `{ modules: Partial<Record<id, boolean>>, expectedRevision, setupCompleted? }`
  - `requestRestart` (`SYSTEM_OPERATE`) — self SIGTERM through the process restart controller
    (`PLATFORM_RESTART_MODE=supervisor`, legacy `PLATFORM_OIDC_RESTART_MODE` still honoured).
- **Client**: `window.__SERVER_CONFIG__.config.enterprise.modules` (boot, sync) and
  `platform.getCapabilities().modules` (live). Both fail open when absent.

## Admin page

`/admin/system/modules` (nav group _System_, `SYSTEM_READ` to view, `SYSTEM_OPERATE` to change):

- **Presets** 小机器 / 标准 / 完整 are a starting point; every module can then be toggled
  individually. When the selection matches no preset the page shows 自定义.
- **Summary bar** (live, from the draft): estimated resident memory, background jobs,
  per-message work, required sidecars (S3 / Redis / search / external service), and how many
  changes need a restart — with a comparison against the presets.
- **Per-module tags** from the constant table's `cost` metadata: 需重启，子进程，负载敏感，
  每条消息 / 每次请求 / 每次出站 / 使用时，N 个后台任务，sidecar chips, dependency warnings.
  Status badge: 运行中 / 已停用 / 待重启 / 由环境变量控制 (switch disabled, tooltip names the
  container variable). Core modules are listed read-only.
- **Save** is CAS-protected (`expectedRevision`); turning off 审计 / 内容审计 asks for
  confirmation and re-authentication; the toast states what changed. A restart banner appears
  when restart-kind modules changed; 立即重启 calls `admin.modules.requestRestart`, or the page
  tells you to restart the container yourself when supervisor mode is off.
- **First run**: until `setup_completed_at` is set, the admin overview shows a guide card
  (choose modules → check infrastructure → done) that opens the same page in a 3-step wizard
  state (`?wizard=1`).
- **Degradation**: nav items of disabled modules are hidden; a direct link renders
  「模块未启用」 with the exact reason (env variable or "enable it under 系统 → 模块"), never a
  404; tRPC calls surface `PLATFORM_MODULE_DISABLED` as a toast.

## Module table

<!-- BEGIN MODULE TABLE -->

| id                  | origin   | tier     | kind    | minimal | standard | full | cost                                               |
| ------------------- | -------- | -------- | ------- | ------- | -------- | ---- | -------------------------------------------------- |
| `knowledgeBase`     | upstream | full     | hot     | ✗       | ✗        | ✓    | rss 0MB, 0 jobs, onUse, s3                         |
| `imageGen`          | upstream | standard | hot     | ✗       | ✓        | ✓    | rss 0MB, 0 jobs, onUse, s3                         |
| `speech`            | upstream | full     | hot     | ✗       | ✗        | ✓    | rss 0MB, 0 jobs, onUse                             |
| `webSearch`         | upstream | standard | hot     | ✗       | ✓        | ✓    | rss 0MB, 0 jobs, onUse, searxng                    |
| `market`            | upstream | full     | hot     | ✗       | ✗        | ✓    | rss 0MB, 0 jobs, onUse                             |
| `memory`            | upstream | standard | hot     | ✗       | ✓        | ✓    | rss 0MB, 0 jobs, perMessage                        |
| `bots`              | upstream | full     | restart | ✗       | ✗        | ✓    | rss 22MB, 1 jobs, onUse                            |
| `agentSignal`       | upstream | full     | restart | ✗       | ✗        | ✓    | rss 0MB, 0 jobs, onUse, redis                      |
| `workflows`         | upstream | full     | hot     | ✗       | ✗        | ✓    | rss 0MB, 0 jobs, onUse, externalService            |
| `sandbox`           | upstream | full     | hot     | ✗       | ✗        | ✓    | rss 0MB, 0 jobs, onUse, externalService            |
| `deviceGateway`     | upstream | full     | hot     | ✗       | ✗        | ✓    | rss 0MB, 0 jobs, onUse, externalService            |
| `managedAi`         | fork     | minimal  | hot     | ✓       | ✓        | ✓    | rss 6MB, 0 jobs, perMessage                        |
| `managedSkills`     | fork     | minimal  | hot     | ✓       | ✓        | ✓    | rss 0MB, 0 jobs, none                              |
| `managedConnectors` | fork     | standard | restart | ✗       | ✓        | ✓    | rss 0MB, 3 jobs, none                              |
| `managedAgents`     | fork     | standard | restart | ✗       | ✓        | ✓    | rss 0MB, 1 jobs, none                              |
| `settingsPolicy`    | fork     | minimal  | hot     | ✓       | ✓        | ✓    | rss 0MB, 0 jobs, perRequest                        |
| `branding`          | fork     | minimal  | hot     | ✓       | ✓        | ✓    | rss 6MB, 1 jobs, none, s3                          |
| `databaseIdp`       | fork     | minimal  | restart | ✓       | ✓        | ✓    | rss 0MB, 2 jobs, none                              |
| `audit`             | fork     | standard | restart | ✗       | ✓        | ✓    | rss 0MB, 2 jobs, perRequest, s3                    |
| `moderation`        | fork     | standard | restart | ✗       | ✓        | ✓    | rss 0MB, 0 jobs, perMessage, load-sensitive, redis |
| `networkProxy`      | fork     | standard | restart | ✗       | ✓        | ✓    | rss 8MB, 3 jobs, perFetch, subprocess              |
| `platformStats`     | fork     | minimal  | hot     | ✓       | ✓        | ✓    | rss 0MB, 0 jobs, onUse                             |
| `taskTemplates`     | fork     | full     | hot     | ✗       | ✗        | ✓    | rss 0MB, 0 jobs, none                              |

<!-- END MODULE TABLE -->

**Cost columns.** `rss` is estimated extra resident memory once the module is
loaded (MB, reference build; `?` = not measured yet). `jobs` is the number of
background pollers. `loadKind` is `none` / `onUse` / `perRequest` / `perMessage`
/ `perFetch`. `load-sensitive` means the module may add an extra model
round-trip or heavy CPU when configured. `subprocess` means it owns an OS
process (e.g. mihomo). External deps (`s3` / `redis` / `searxng` /
`externalService`) are soft requirements — the module degrades if they are
missing.

**Tier** is the lowest preset in which the module is ON. Core surfaces
(chat, auth, `/admin` skeleton, BYOK providers, file upload _when S3 is
configured_) are not modules and cannot be turned off.

## Presets & sizing

| Preset     | Typical box       | `LOBE_NODE_HEAP_MB` | Sidecars      | What you keep                                                                                          |
| ---------- | ----------------- | ------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `minimal`  | 1–2 CPU / 2–4 GiB | **1024**            | ParadeDB only | Chat + admin skeleton + managed AI/skills, settings policy, branding, stats, DB identity               |
| `standard` | 2–4 CPU / 4–8 GiB | **1536** (default)  | + Redis + S3  | Above + audit / moderation / network proxy / managed agents & connectors / image / memory / web search |
| `full`     | 4+ CPU / 8+ GiB   | **2048**            | + SearXNG     | Everything. This is the default and today's behaviour.                                                 |

### Measured (reference build, arm64, standalone server, 2026-08-17)

|                                      | before this batch                                               | after                                                                    |
| ------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Idle CPU of `next-server`            | \~1.5 % (11 workers polling every 2–5 s, \~2.3 DB xact/s)       | \~0.1 % / \~0.2 xact/s (workers module-gated + idle backoff to 60 s)     |
| Boot RSS (`full`)                    | \~500 MB (every server entry pre-required at Ready)             | \~275 MB (`preloadEntriesOnStart: false`, entries load on first request) |
| RSS after a typical browsing session | \~650 MB (first tRPC call pulled the whole static router graph) | \~375 MB (every non-core sub-router is tRPC `lazy()`)                    |
| Boot RSS `minimal` vs `full`         | —                                                               | ≈ −45 MB at boot (gateway / audit / connector graphs never load)         |
| Image                                | 1.72 GB (`/app/dist` 270 MB of Vite intermediates traced in)    | \~1.07 GB                                                                |
| First-screen JS (chat home)          | 33.8 MB / 423 files                                             | 22.4 MB / 127 files                                                      |

Cold latency of a lazily loaded router is +20–60 ms once per process; the very first
request after boot pays \~0.4 s to load the tRPC entry.

Heap is a **V8 old-space cap**, not a container memory limit. Idle RSS of the
current image is \~375 MiB after warm-up; 1024 is tight under load (knowledge-base parse +
concurrent streams). Symptom of too-low a cap: process exit with
`JavaScript heap out of memory`, then Compose `restart: always` loops it.
Unset = no cap (raw `docker run`). Compose injects `1536`. `0` also disables.

OOM-kill of the _container_ (as opposed to V8) means `mem_limit` is below
heap + native buffers (canvas / sharp / ffmpeg). Leave \~1.5× heap for RSS.

## Env reference

| Variable                               | Default        | Meaning                                                                                                                                                                 |
| -------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOBE_MODULE_PRESET`                   | `full`         | `minimal` \| `standard` \| `full`. Sets the _default_ enabled set.                                                                                                      |
| `LOBE_MODULES_DISABLED`                | empty          | Extra module ids to force off, comma-separated (`bots,knowledgeBase`).                                                                                                  |
| `ENABLE_PLATFORM_*`                    | on             | Legacy enterprise flags. An explicit `0` also disables the mapped module.                                                                                               |
| `LOBE_NODE_HEAP_MB`                    | unset (no cap) | Appended to the **child** `NODE_OPTIONS` by `startServer.js` **only when set**. Compose injects `1536`. Does not clobber an existing `--max-old-space-size`. `0` = off. |
| `ENABLE_BOT_GATEWAY`                   | on             | `0` skips the launcher POST to `/api/agent/gateway/start`. G2's handler also no-ops when the `bots` module is off.                                                      |
| `SKIP_DB_MIGRATION`                    | unset          | `1` skips `/app/docker.cjs` (only if you migrate the DB yourself).                                                                                                      |
| `REDIS_URL`                            | empty          | Empty → Redis off (`enabled: false`). Required for multi-replica config invalidation.                                                                                   |
| `S3_ENDPOINT` / `S3_SECRET_ACCESS_KEY` | empty          | Empty → `enableUploadFileToServer` is false; uploads / KB files / branding assets stay off.                                                                             |
| `SEARXNG_URL`                          | empty          | Empty → built-in SearXNG search is off; other search providers still work.                                                                                              |
| `FEATURE_FLAGS`                        | all on         | Upstream flags. Disabled modules also force the mapped flags off (`knowledge_base`, `ai_image`, `speech_to_text`, `market`).                                            |

## Compose profiles

File: [`docker-compose/enhanced/docker-compose.yml`](../../docker-compose/enhanced/docker-compose.yml).
ParadeDB, Redis and rustfs are **always on** (today's stack; existing `.env`
files keep working). SearXNG is new and opt-in (`profiles: [search]`). The
smaller box is a sibling file, not a missing-profile default.

| Command                                              | Sidecars                  | Suggested preset    |
| ---------------------------------------------------- | ------------------------- | ------------------- |
| `docker compose up -d`                               | ParadeDB + Redis + rustfs | `full` / `standard` |
| `docker compose --profile search up -d`              | + SearXNG                 | `full`              |
| `docker compose -f docker-compose.minimal.yml up -d` | ParadeDB only             | `minimal`           |

`docker-compose.yml` still hard-checks `S3_ENDPOINT` / `S3_PUBLIC_DOMAIN`
(`:?`). The minimal file leaves them empty; the app then disables
server-side uploads. Commented `mem_limit` / `cpus` examples live on the
`lobehub` service.

## What each disabled module hides / returns

A disabled module does **not** unmount its router.

**tRPC** (`throwEnterpriseError` → lambda `errorFormatter` `cause.data` →
`errorData`; client reads `data.errorData` in `mapEnterpriseError.ts`):

```json
{
  "error": {
    "code": "FORBIDDEN",
    "data": {
      "errorData": {
        "code": "PLATFORM_MODULE_DISABLED",
        "details": { "moduleId": "<id>" }
      }
    }
  }
}
```

**Hono / webapi** (`webapiModuleGate.ts`, HTTP 403):

```json
{ "error": "PLATFORM_MODULE_DISABLED", "moduleId": "<id>" }
```

| Module              | Hidden from the user                                  | Still there            | Extra boot cost if left on             |
| ------------------- | ----------------------------------------------------- | ---------------------- | -------------------------------------- |
| `knowledgeBase`     | KB / RAG / chunk / ragEval UI (`knowledge_base` flag) | pgvector tables        | file-loader / canvas on first parse    |
| `imageGen`          | Image / video / ComfyUI (`ai_image` flag)             | —                      | `sharp` / `ffmpeg-static` on first use |
| `speech`            | TTS / STT (`speech_to_text` flag)                     | —                      | —                                      |
| `webSearch`         | Built-in search / web-browsing tool                   | Other search providers | 11 search-provider imports             |
| `market`            | Agent / plugin market (`market` flag)                 | —                      | —                                      |
| `memory`            | User-memory extraction                                | tables                 | per-message extractor                  |
| `bots`              | Messenger / gateway                                   | —                      | GatewayService + 9 adapters (restart)  |
| `agentSignal`       | Agent-signal workflows                                | —                      | eager graph (restart)                  |
| `workflows`         | Upstash workflow routes                               | —                      | needs QStash                           |
| `sandbox`           | Python / cloud sandbox tools                          | —                      | needs sandbox service                  |
| `deviceGateway`     | Remote-device routes                                  | —                      | needs `DEVICE_GATEWAY_URL`             |
| `managedAi`         | Platform AI catalog                                   | BYOK providers         | per-message catalog lookup             |
| `managedSkills`     | Platform skill catalog                                | user skills            | —                                      |
| `managedConnectors` | Connector admin + 3 workers                           | —                      | restart                                |
| `managedAgents`     | Platform assistants + rollout worker                  | user agents            | restart                                |
| `settingsPolicy`    | Platform default / lock policy                        | user settings          | per-request resolve                    |
| `branding`          | Runtime brand assets                                  | build-time brand       | S3 cleanup job                         |
| `databaseIdp`       | DB identity providers + 2 workers                     | env SSO                | restart                                |
| `audit`             | Audit UI + 2 workers                                  | —                      | restart; export needs S3               |
| `moderation`        | Content-moderation wrapper                            | —                      | per-message, load-sensitive            |
| `networkProxy`      | mihomo subprocess + egress wrap                       | direct egress          | restart + subprocess                   |
| `platformStats`     | Global stats page                                     | —                      | heavy on-demand queries                |
| `taskTemplates`     | Task-template admin / home                            | —                      | —                                      |

Permissions are orthogonal: turning a module off never revokes RBAC.

## Background workers

The six `platform_jobs` pollers (`auditExport`, `auditRetention`, `agentRollout`,
`connectorRuntimeAudit`, `connectorSecretCleanup`, `secretRewrap`) share one
scheduler (`enterprise/jobs/platformJobsDispatcher.ts`). It claims a mixed-type
batch with `SELECT … FOR UPDATE SKIP LOCKED` at `min(interval)` of the types
whose module is on in the boot view (plus the Vault predicate for
`secretRewrap`), then dispatches each row to the existing per-type handler.
Disabled modules are never claimed; the registry still logs
`[modules] worker <name> skipped: module <id> disabled` for those names so the
modules page listing stays unchanged. Advisory-lock cleanups, branding GC,
shared-OAuth keepalive, the mihomo supervisor, GatewayService, and readiness
probes stay on their own loops.

## Restart semantics

Modules with `kind: restart` own a boot-time facility (worker, subprocess,
gateway, or eager import). Saving a change:

1. The API / UI gate flips immediately (soft switch).
2. The admin page shows **pending restart** for those ids.
3. `admin.modules.requestRestart` asks the existing identity-provider
   restart controller to SIGTERM this process.
4. Compose `restart: always` (and `PLATFORM_OIDC_RESTART_MODE=supervisor`)
   brings a new process up, which re-reads env + DB and drops the workers.

If restart is not supported (`supervisor` mode off, or not running under a
supervisor), the UI tells the operator to bounce the container themselves.

## Image size notes

E3 baseline (`aihub:demo`, 2026-08-17): **1.72 GB** image, **1.25 GiB** `/app`,
of which `dist/` was 270 MiB of unused Vite intermediates.

This batch:

- Docker `outputFileTracingExcludes` drops `dist/desktop|mobile|auth`,
  `apps/desktop`, `apps/cli`, `e2e/`, `tests/`, `*.tsbuildinfo`, the duplicate
  migrations (Dockerfile already copies them to `/app/migrations`),
  `changelog/`, `docker-compose/`. A bare `dist/**` is **unsafe**: Next matches
  excludes with picomatch `{ contains: true }`, and `./dist/**` also hits
  `node_modules/next/dist/**` (drops `app-route-turbo.runtime.prod.js`) and
  `es-toolkit/dist/**`.
- `define-config.ts` no longer _includes_ `dist/desktop/**` and
  `dist/mobile/**` (the comment said exclude; the code did the opposite).
- `public/_spa/**` stays included — that is what the runtime serves
  (`scripts/copySpaBuild.mts`).
- `src/`, `packages/`, `apps/server` are **not** excluded. G0 §D: an opaque
  `path.resolve(process.cwd(), <const>)` in `networkProxy/engine/platform.ts`
  triggered a whole-project trace. The commander replaced that with literal
  path segments; whether those trees disappear is verified on the r2 image.
- The final scratch image is two layers: (a) OS + `/app/node_modules` and
  (b) the app payload (`.next`, `public`, launcher, remnants). A source-only
  rebuild reuses layer (a).
- `@napi-rs/canvas` keeps **one** `skia.node`: the hoisted
  `node_modules/@napi-rs/canvas-linux-*` that `require()` resolves. The two
  `.pnpm` copies are dropped (tracing exclude + busybox prune).
  `js-binding.js` walks up to the hoisted package. sharp-libvips **1.2.4 and
  1.3.2 both stay** — app `sharp@0.34.5` vs Next's own `sharp@0.35.3`
  (different SONAMEs). `@vitejs/devtools` is still pruned.
- `ffmpeg-static` stays in the default (full) image. The import is
  `await import('ffmpeg-static')` behind `isBootModuleEnabled('imageGen')`,
  so a later image can exclude the 49 MiB binary when `imageGen` is off.
  Do not restore `WITH_VIDEO` — `serverExternalPackages` still lists it.
- Heap cap is applied in `startServer.js` **only when `LOBE_NODE_HEAP_MB` is
  set**. Compose injects `1536`. Image `NODE_OPTIONS` stay
  `--dns-result-order=ipv4first --use-openssl-ca`.

Measured on `aihub:slim-r2` (2026-08-17, arm64, commander `platform.ts`
fix included): image **1.07 GB** (was 1.72 GB), `/app` **634 MiB**
(was 1.25 GiB), `/app/src` **80 KiB** (was 43 MiB). Phase-2 layering
numbers: `audit/slim-2026-08-17/phase2/reports/G5.md`.

## Phase 2 / handoff

The next slimming round (builtin-tools split, `platform_jobs` dispatcher, per-message costs, first-screen vendor chunk, image layering, polling) is specified in [`audit/slim-2026-08-17/HANDOFF.md`](../../audit/slim-2026-08-17/HANDOFF.md) together with all measurement reports of round 1.
