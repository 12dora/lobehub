# E3 — Docker 镜像 / 构建 / 外部依赖与部署足迹

测量时间 2026-08-17，镜像 `aihub:demo`（ID 1cd8d2de47dd，`docker images` 报 1.72GB）。
原始输出：`scratchpad/slim/explore/e3_raw/`（history.txt / du_top.txt / du_deep.txt / du_spa.txt /
du_native.txt / chk.txt / stats.txt / sidecar_images.txt / boot_log.txt）。

## A. Summary（给指挥官决策）

1. 镜像 1.25 GiB 实体中，**约 330 MiB 是纯垃圾、另有约 220 MiB 大概率可裁**，合计可砍 ~45%：最大单块是
   `/app/dist` 270 MiB —— 它是 Vite 中间产物，运行时只读 `public/_spa`（`scripts/copySpaBuild.mts:8-10`）。
2. 根因是一处**注释与代码相反的配置**：`src/libs/next/config/define-config.ts:42-45` 在 Docker 分支把
   `dist/desktop/** dist/mobile/**` 写进 `outputFileTracingIncludes`（注释写的是 "Exclude … from
   serverless functions"）；真正的 excludes 在 `next.config.ts:9-20` 里**只在 `isVercel` 时生效**，Docker 构建拿不到。
3. 镜像还整包携带源码：`/app/src` 43 MiB（6017 个 .ts）、`/app/apps/desktop` 27 MiB（其中 build 图标 25 MiB）、
   `/app/apps/cli` 9.7 MiB、`/app/e2e`、`/app/tests`、`tsconfig.tsbuildinfo` 12 MiB、migrations 双份 10 MiB。
4. `node_modules` 268 MiB 里：`ffmpeg-static` 49 MiB（仅视频生成用）、`@napi-rs/canvas` 的 skia.node 27 MiB **存了 3 份**、
   `sharp-libvips` 两个版本共 33 MiB、`@vitejs/devtools` 4 份 9.5 MiB（开发依赖漏进运行时）。
5. 运行时**没有任何堆上限**：镜像的 `NODE_OPTIONS` 只有 dns/openssl 两项（`Dockerfile:182`），compose 也没有
   `mem_limit`；实测 `aihub-demo-app` idle RSS 674 MiB。加 `--max-old-space-size` 是零代码改动的第一档止血。
6. 外部依赖：**ParadeDB 是硬依赖**（`0000_squash_baseline.sql:5` `CREATE EXTENSION pg_search` + 14 个 bm25 索引），
   S3 在 enhanced compose 是**必填**（`docker-compose/enhanced/docker-compose.yml:71` 用 `:?` 强制），
   Redis 已经是可选（`packages/env/src/redis.ts:44-52` 返回 `enabled:false`），searxng 纯 env 可选。
7. 侧车 idle RSS：postgres 216 MiB / rustfs 71 MiB / searxng 16 MiB / redis 5 MiB；镜像盘占
   paradedb 1.35GB + rustfs 338MB + searxng 372MB + redis 59MB。**"重"的 69% 在 app 自己身上，其次是 ParadeDB。**
8. 每次启动都会跑 migration（`startServer.js:226-243`）并**无条件拉起 bot gateway**（`startServer.js:246`）。
9. 已有 DB 落库的基础设施配置表 `platform_infra_settings`（mail / object storage 两条，含 revision + 缓存失效），
   `packages/database/src/schemas/platform/infraSettings.ts:16` —— 首次运行图形向导应该扩这张表，而不是新造机制。
10. 建议分档：`minimal`(app+ParadeDB) / `standard`(+redis+S3) / `full`(+searxng+代理+审核)，用 compose profiles 表达。

## B. Findings（按重要度）

### B1 [HIGH] `/app/dist` 270 MiB 是运行时永不读取的构建中间产物

- 实测：`/app/dist` 276,504 KiB = 270 MiB，占 `/app`(1126 MiB) 的 24%；细分
  `dist/desktop` 117 MiB、`dist/mobile` 113 MiB、`dist/auth` 38 MiB（`e3_raw/du_top.txt`、`du_spa.txt`）。
- 运行时真正被 serve 的是 `public/_spa`(106 MiB) 与 `public/_spa-auth`(33 MiB)，由
  `scripts/copySpaBuild.mts:8-10` 从 `dist/{desktop,mobile,auth}` 复制而来；HTML 模板在构建期就被
  `scripts/generateSpaTemplates.mts:6-9` 内联成了 TS 常量（如 `src/app/spa-auth/authHtmlTemplate.ts:4`）。
- 全仓 grep 只有构建脚本读 `dist/`，`src/` 与 `apps/server/src` 无任何运行时引用。
- 额外重复：`dist/desktop/_spa-auth` 34 MiB —— desktop 构建把已经生成的 `public/_spa-auth` 又当静态资源拷了一遍。
- 注：`dist/*` 内**没有 sourcemap**（`find /app/dist -name '*.map'` = 0），所以这 270 MiB 全是重复的 JS/i18n 资产。

### B2 [HIGH] tracing includes/excludes 语义颠倒 + excludes 只对 Vercel 生效

- `src/libs/next/config/define-config.ts:33-56`：Docker 分支 `buildWithDocker` 把
  `'public/_spa/**' 'dist/desktop/**' 'dist/mobile/**' 'packages/database/migrations/**'` 放进
  **`outputFileTracingIncludes`**，注释却写着 "Exclude SPA/desktop/mobile build artifacts from serverless functions"。
- `next.config.ts:5-27`：真正的 `outputFileTracingExcludes`（含 musl 二进制、`public/_spa/**`、`dist/*`、
  `apps/desktop/**`）被包在 `isVercel ? vercelConfig : {}` 里 —— Docker 构建走不到。
- 后果之一：`packages/database/migrations` 10.3 MiB 与 Dockerfile 单独 COPY 的 `/app/migrations`
  (`Dockerfile:157`) 完全重复。

### B3 [HIGH] 源码 / 开发资产整包进入运行镜像

`e3_raw/du_top.txt` + `chk.txt`（单位 KiB）：

| 路径 | 大小 | 运行时是否需要 |
|---|---|---|
| `/app/src` | 43,960（6017 个 .ts/.tsx） | 否（已编译进 `.next/server`）[需验证] |
| `/app/apps/desktop` | 27,988（其中 `build/` 图标 25,688） | 否，Electron 专用 |
| `/app/apps/server` | 19,532 | 否（同上）[需验证] |
| `/app/apps/cli` | 9,896 | 否 |
| `/app/packages` | 42,612（含 database/migrations 10,564 重复） | 部分 |
| `/app/tsconfig.tsbuildinfo` | 12,560 | 否，纯 TS 增量缓存 |
| `/app/e2e` + `/app/tests` + `/app/vitest.config.mts` | 1,164 | 否 |
| `/app/changelog` + `/app/docker-compose` | 1,968 | 否 |

`.git` / `.gitignore` / `README.md` 都不在镜像里（`chk.txt`），说明不是"整目录 COPY"，而是
Next 16 turbopack standalone 的 tracing 把工作区源码拉了进来 —— 但 `apps/desktop/build`（25 MiB 安装器图标）
不可能被代码 trace 到，所以确切机制**未定论 [guess]**，见 E1。无论机制为何，用一条 Docker 侧
`outputFileTracingExcludes` 都能把它们挡掉。

### B4 [MED] node_modules 268 MiB 中约 130 MiB 与可选模块 / 重复版本相关

`e3_raw/du_deep.txt` + `du_native.txt`（KiB）：

| 包 | 大小 | 归属模块（E2 候选表映射） |
|---|---|---|
| `ffmpeg-static@5.3.0` | 50,048（单个 ffmpeg 二进制 49,936） | 视频生成 `apps/server/src/services/generation/video.ts:26`（`require()` 懒加载） |
| `@napi-rs/canvas` skia.node | 27,064 **× 3 份**（`/app/node_modules/@napi-rs/...`、`.pnpm/@napi-rs+canvas@…`、`.pnpm/@napi-rs+canvas-linux-arm64-gnu@…`，三个独立 inode） | 文件解析 / PDF（`packages/file-loaders/src/loaders/index.ts`）→ 知识库 |
| `@img/sharp-libvips-linux-arm64` | 17,440(1.3.2) + 16,480(1.2.4)，**两个版本共存** | 图片处理（依赖收敛问题，非模块问题） |
| `@larksuiteoapi/node-sdk` | 6,092 | 飞书 bot（`apps/server/src/services/bot/platforms/feishu/gateway.ts`） |
| `pdfkit` 4,000 + `pdfjs-dist` 3,224 | 7,224 | 导出 PDF（`apps/server/src/routers/lambda/exporter.ts`）/ PDF 解析 |
| `@vitejs/devtools*` × 4 | 9,760 | **开发依赖泄漏**，运行时不需要 |
| `discord.js` | 2,456 | Discord bot |

镜像中只有 arm64/gnu 变体，没有 musl/x64 冗余（`du_native.txt` 的 `musl|x64` grep 只命中 arm64 条目），
即 Vercel 那条 musl 排除对本地 Docker 无意义。无 `*.wasm`（tiktoken 走 JS 实现），无 playwright/python。

### B5 [MED] 运行时无内存/CPU 约束，构建期堆上限 8 GB

- 镜像 `NODE_OPTIONS="--dns-result-order=ipv4first --use-openssl-ca"`（`Dockerfile:182`）——
  **没有 `--max-old-space-size`**，V8 按容器可见内存自适应（本机 19.5 GiB → 老生代默认可涨到 ~2 GiB 级别）。
- `docker-compose/enhanced/docker-compose.yml` 全文无 `mem_limit` / `deploy.resources` / `cpus`。
- 构建期：`package.json:45` `build:docker` = 三次 `vite build` + `next build`，每步
  `NODE_OPTIONS=--max-old-space-size=8192`（`package.json:49,50,52`），`build:next` 单独 7168
  （`package.json:46`）。运营者在目标机自建镜像**需要 ≥8 GB 可用内存 × 4 个串行阶段**。
- 实测 idle（`e3_raw/stats.txt`）：`aihub-demo-app` CPU 1.42% / RSS 674.4 MiB。

### B6 [MED] 外部依赖矩阵

| 依赖 | 今天是否可选 | 证据 | 关掉会坏什么 | 镜像/RSS |
|---|---|---|---|---|
| **ParadeDB (pg_search)** | ❌ 硬依赖 | `packages/database/migrations/0000_squash_baseline.sql:5` `CREATE EXTENSION IF NOT EXISTS pg_search`；14 处 `USING bm25`（agents/topics/files/knowledge_bases/user_memories/chat_groups/…）；`packages/database/src/repositories/search/index.ts` 与 `home/index.ts:398,417` 用 `@@@` 与 `paradedb.score()` | migration 直接失败，普通 pg+pgvector 起不来 | 镜像 1.35GB / idle 216 MiB |
| pgvector | ❌ 硬依赖 | 同文件 `:3` `CREATE EXTENSION vector` | RAG | 同上 |
| pg_trgm | 硬依赖（条件建） | `0000_squash_baseline.sql:4498`、`0001_upgrade_from_2_2_10.sql:2603,2879` | 模糊搜索 | — |
| **Redis** | ✅ 已可选 | `packages/env/src/redis.ts:44-52` 无 URL 即 `enabled:false`；`apps/server/src/modules/AgentRuntime/redis.ts:33-42` 返回 null 并 warn | Agent Runtime 流式状态/事件、`RedisRuntimeConfigProvider`（feature flags 热更新）、`platformConfigInvalidation`（多实例配置失效）、connector 运行态、home 缓存、S3 缓存、生成延迟统计 → 单实例仍能跑，多实例会不一致 | 59MB / **5 MiB** |
| **S3 / rustfs** | ⚠️ 代码可选、compose 强制 | `docker-compose/enhanced/docker-compose.yml:71-72` 用 `${S3_ENDPOINT:?…}` 强制；代码侧 `apps/server/src/enterprise/services/branding/assetStorage.ts:162` 有 `Boolean(S3_BUCKET && …)` 守卫 | 文件上传 / 头像 / 知识库 / 审计导出 / 品牌资产 | 338MB / 71 MiB |
| searxng | ✅ 已可选 | `apps/server/src/services/search/impls/searxng/index.ts:22` 无 `SEARXNG_URL` 直接返回；enhanced compose 根本没这服务，只有 `docker-compose/deploy/docker-compose.yml:124` 有 | 内置联网搜索（可换外部 provider） | 372MB / 16 MiB |
| rustfs-init (minio/mc) | 一次性 | `…/enhanced:158-171` | 建 bucket | 一次性容器 |
| lkg-init (busybox) | 一次性 | `…/enhanced:173-179`，只为 `chown 1001:1001 /lkg` | OIDC LKG 快照目录权限 | 6.22MB |

侧车合计 idle RSS ≈ 308 MiB，**app 自己 674 MiB 占整套 69%** —— 裁侧车省的是磁盘和少量内存，真正的
CPU/内存热点在 Node 进程（E1/E2 的范围）。

### B7 [MED] 启动路径：每次启动都迁移 + 无条件拉起 gateway

`docker logs aihub-demo-app`（`e3_raw/boot_log.txt`）与 `scripts/serverLauncher/startServer.js`：

- `:226-243` 只要 `DATABASE_DRIVER` 有值就 spawn 一个**独立 node 进程**跑 `/app/docker.cjs`（drizzle migrator），
  串行阻塞在 server 之前。日志里没有耗时打点（`scripts/migrateServerDB/docker.cjs:16,21` 只打印起止），
  空库/已迁移库的实际耗时**未测**（见 E3）。
- `:246` `startGateway()` 只要 `KEY_VAULTS_SECRET` 存在就 POST `/api/agent/gateway/start`，
  最多重试 10 次 × 3 s；日志确认 `[GatewayService] Started successfully`。**没有开关 env**。
- `:249` `createQstashSchedule()` 无 token 时优雅跳过（日志已确认）。
- 启动日志里还有两条 `[identityProviderStartup] critical … snapshot failure` 与两条 QStash 报错噪音。

### B8 [LOW] 镜像是一层 1.34GB 的 `COPY / /`

`docker history` 显示除环境变量外只有一条 `1.34GB COPY / / # buildkit`（`Dockerfile:179`，`FROM scratch` 阶段）。
后果：任何一行代码改动都要重推/重拉 1.34GB，没有任何层复用（node 二进制 116 MiB、curl-impersonate 29 MiB
这类几乎不变的内容本可以独立成层）。

### B9 [LOW] 现成的运行期 knobs（不改代码即可用）

| env | 默认 | 效果 | 证据 |
|---|---|---|---|
| `NODE_OPTIONS=--max-old-space-size=<MB>` | 未设 | 压住 V8 老生代，直接影响 RSS | `Dockerfile:182` |
| `FEATURE_FLAGS=-market,-knowledge_base,-ai_image,-speech_to_text,-changelog` | 全开 | 上游功能开关 | `packages/app-config/src/featureFlags/schema.ts` |
| `ENABLE_PLATFORM_ADMIN` / `_MANAGED_AI` / `_MANAGED_SKILLS` / `_MANAGED_CONNECTORS` / `_MANAGED_AGENTS` / `ENABLE_PLATFORM_SETTINGS_POLICY` / `ENABLE_RUNTIME_BRANDING` / `ENABLE_DATABASE_OIDC` | 全开 | 企业模块开关，compose 已透传 | `docker-compose/enhanced/docker-compose.yml:38-46` |
| `SEARXNG_URL` 留空 | 空 | 关内置搜索 | `services/search/impls/searxng/index.ts:22` |
| `REDIS_URL` 留空 | enhanced 里已填 | 关 Redis（单实例可接受） | `packages/env/src/redis.ts:44` |
| `ENABLE_TELEMETRY` | 未设 = 关 | OTel 已默认关 | `src/instrumentation.ts:77` |
| `PROXY_URL` 留空 | 空 | 不生成 proxychains、不套壳启动 | `startServer.js:209-215` |
| `PLATFORM_OIDC_RESTART_MODE` | supervisor | — | `…/enhanced:50` |

**缺口**：`apps/server/src/enterprise/jobs` 与 `src/instrumentation.ts` 里 `process.env` 只出现
`NEXT_RUNTIME/NODE_ENV/VERCEL*/ENABLE_TELEMETRY*/ENABLE_BOT_IN_DEV/DATABASE_URL` —— 所有定时任务的
**周期和开关都是硬编码**，运营者今天没有任何 job 级 knob。

### B10 [INFO] 现成的 DB 落库基础设施配置（首次运行向导的落点）

- 表：`platform_infra_settings`（`packages/database/src/schemas/platform/infraSettings.ts:16`）。
- 服务：`apps/server/src/enterprise/services/infraSettings/snapshot.ts`（DB 覆盖 env 的 snapshot、
  fingerprint、revision、`DomainConfigCache` + 跨实例失效），两条固定行
  `INFRA_SETTINGS_ID_MAIL` / `INFRA_SETTINGS_ID_OBJECT_STORAGE`（`@/const/platform/infraSettings`）。
- 语义：DB 行存在则 `source:'db'`，否则回落 env（`snapshot.ts:29-36` `InfraConfigSource = 'db' | 'env'`）。
  这就是"图形向导写一次、env 作兜底"的既有范式，模块开关应复刻它而不是另起炉灶。

## C. Recommended seams（改动最少 / 对上游 merge 友好）

| # | seam | 位置 | 归属 | 改动量 | 收益 |
|---|---|---|---|---|---|
| C1 | 给 Docker 构建补一份 `outputFileTracingExcludes`：`dist/**`、`apps/desktop/**`、`apps/cli/**`、`e2e/**`、`tests/**`、`*.tsbuildinfo`、`packages/database/migrations/**`（Dockerfile 已单独 COPY） | `next.config.ts:5-27`（把 `vercelConfig` 泛化成 `isVercel ? vercel : (DOCKER ? docker : {})`） | **upstream 文件，但 fork 已在此处有独立分支块**，加 ~12 行、不碰上游既有键 | 小 | **-330 MiB** 镜像 |
| C2 | 删掉 `dist/desktop/** dist/mobile/**` 两条 include（它们与注释意图相反） | `src/libs/next/config/define-config.ts:44-45` | upstream 文件，删 2 行 | 极小 | 与 C1 重叠，单独也能省 -230 MiB |
| C3 | 可选原生依赖用 build ARG 决定是否 trace：`ARG WITH_VIDEO=0 / WITH_DOC_PARSER=1`，对应把 `ffmpeg-static`、`@napi-rs/canvas`、`pdfjs-dist/pdfkit` 加进 excludes；三者都已是 `require()` 懒加载或 `serverExternalPackages`，缺失时只影响对应功能 | `next.config.ts` + `Dockerfile` 的 builder 阶段 | 混合（Dockerfile 是 fork 已重度改造过的文件） | 中 | -50 ~ -130 MiB |
| C4 | 拆层：把 `COPY --from=app / /` 拆成 3 条（`/bin+/lib+/usr` 不变层 → `/app/node_modules` → `/app` 其余） | `Dockerfile:176-179` | fork 已改造区 | 小 | 增量拉取从 1.34GB 降到 ~百 MiB 级；镜像总量不变 |
| C5 | compose `profiles`：`redis`/`s3`/`search` 三个 profile，app 的 `depends_on` 用 `required:false`；`S3_ENDPOINT` 的 `:?` 硬校验改成 profile 内校验 | `docker-compose/enhanced/docker-compose.yml` | **fork-only** | 小 | 少起 1~3 个侧车（-59/-338/-372 MB 盘，-92 MiB RSS） |
| C6 | 启动脚本两个 env guard：`SKIP_DB_MIGRATION=1`（跳 `/app/docker.cjs`）、`ENABLE_BOT_GATEWAY=0`（跳 `startGateway`） | `scripts/serverLauncher/startServer.js:226,246` | upstream 文件，各加 1 个 if（3 行） | 极小 | 冷启动更快；不需要 bot 的部署少一个常驻 gateway |
| C7 | 默认给容器加堆上限与资源上限：compose 里 `NODE_OPTIONS=--max-old-space-size=${LOBE_NODE_HEAP_MB:-1024}` + `mem_limit`/`cpus` | `docker-compose/enhanced/docker-compose.yml` | **fork-only** | 极小 | 直接压 RSS 上界，零代码风险 |
| C8 | 模块开关的持久化复用 `platform_infra_settings` 范式：新增一条 `INFRA_SETTINGS_ID_MODULES` 行（JSON: `{modules:{knowledgeBase:false,...}}`），语义同样是 **DB 覆盖 env、env 兜底**，首次运行向导写这行 | `packages/database/src/schemas/platform/infraSettings.ts` + `services/infraSettings/snapshot.ts` | **fork-only** | 中 | 向导 + 管理端读同一 snapshot，不新造机制 |

**分档部署形态（建议）**

| 档 | 组件 | 盘占（镜像） | idle RSS | 失去什么 |
|---|---|---|---|---|
| `minimal` | app + ParadeDB | 1.72GB + 1.35GB | ~890 MiB | 文件上传/知识库/头像/审计导出（无 S3）；多实例配置失效与 Agent Runtime 流式状态（无 Redis）；内置搜索 |
| `standard` | + redis + rustfs | +397MB | ~966 MiB | 内置搜索（可接外部 search provider） |
| `full` | + searxng（+ 网络代理引擎运行时下载 + 内容审核） | +372MB | ~982 MiB | — |

ParadeDB 无法退到普通 pg（B6），所以"最小档"仍带 1.35GB 数据库镜像 —— 若要真正的轻量档，需要一个
**"无 bm25"迁移分支**（14 个索引 + `@@@` 查询改 `pg_trgm`/`tsvector`），代价大，本轮不建议（列入 E）。

**镜像瘦身预估汇总**

| 措施 | 估计 |
|---|---|
| C1/C2 去 `dist/` | -270 MiB |
| C1 去 apps/desktop+cli+e2e+tests+tsbuildinfo+重复 migrations | -60 MiB |
| C1 去 `/app/src` + `/app/packages`（**需先验证运行时无动态读取**） | -85 MiB（风险中） |
| C3 去 ffmpeg-static | -49 MiB |
| canvas 三副本收敛成一份（pnpm dedupe / 只 trace `.pnpm` 那一份） | -53 MiB |
| sharp-libvips 版本收敛（1.2.4 与 1.3.2 并存） | -16 MiB |
| 剔除 `@vitejs/devtools`（devDep 泄漏） | -9.5 MiB |
| 只保留部署所需语言（`/app/locales` 18 种共 25 MiB） | -20 MiB（慎，见 D5） |
| **合计** | **约 -560 MiB（镜像 1.25 GiB → ~0.7 GiB）** |

## D. 不要动 / 风险

1. **不要动 `Dockerfile` 的 base→distroless→busybox→scratch 四段结构**（`Dockerfile:5,71,146,176`）——
   这是上游形状，改了每次 merge 都要重解冲突。所有裁剪走 `outputFileTracingExcludes`（数据），不走 COPY 列表（结构）。
2. **不要动 curl-impersonate 阶段**（`Dockerfile:16-19,41-68`）：29 MiB，但 ChatGPT Web provider 靠它过
   Cloudflare 指纹，且 sha256 是 fork 自己钉的安全边界。
3. **不要动 `serverExternalPackages` 列表**（`define-config.ts:356-365`）与
   `dockerCanvasTracingIncludes.ts` —— 后者的注释明确说 turbopack 16.3.0 会把 pnpm 符号链接目录当文件哈希，
   这是踩过的坑；要裁 canvas 只能在 excludes 侧做，且必须同步验证 PDF 解析仍能 `require()` 成功。
4. **不要改 `output: 'standalone'`**（`define-config.ts:31`）与 `serverMinification: false`
   （`:82`，oidc-provider 依赖 `constructor.name`）。
5. **不要删 `/app/locales`**：`packages/locales/src/create.ts:50-58` 通过
   `resourcesToBackend` + `loadI18nNamespaceModule` 在**运行时动态 import** 对应语言的 JSON；
   只能做"按部署语言白名单裁剪"，且必须保留 `en-US`（`create.ts:7-10` 是静态 import 的兜底）。
6. **不要把 ParadeDB 换成 pgvector 镜像**：migration 第 5 行就 `CREATE EXTENSION pg_search`，
   会在启动的第一步硬失败（且 `startServer.js:239` 直接 `process.exit(1)`）。
7. **Redis 关闭的隐藏代价**：`platformConfigInvalidation` / `RedisRuntimeConfigProvider` 依赖它做
   跨实例配置失效（记忆里已有"全局 mutate 打不到缓存"的同类坑）。单实例部署可关；**多副本必须保留**，
   否则管理端改配置后其它副本不生效 —— 向导里要把这条写成硬约束而不是建议。
8. **`S3_ENDPOINT` 的浏览器可达性约束**（`…/enhanced:66-72` 注释）：向导若允许"不启用对象存储"，
   必须同时禁掉上传入口，否则用户会拿到一堆 presign 失败。
9. C1 的排除清单必须**逐条验证**再合：`/app/src`、`/app/packages` 属于"看起来没用但机制不明"（B3/E1），
   建议第一轮只排除 dist / apps(desktop,cli) / e2e / tests / tsbuildinfo / 重复 migrations 这些 100% 安全的。

## E. 需要真机验证的项

1. **`/app/src`(43 MiB)、`/app/packages`(42 MiB)、`/app/apps/server`(19 MiB)、`/app/apps/desktop/build`(25 MiB)
   究竟因何进入 standalone**：`.git`/`README` 不在，说明不是整目录拷贝，但配置里也没有对应 include。
   验证：本地 `DOCKER=true next build` 后看 `.next/standalone` 树 + `.next/**/*.nft.json`，或开
   `NEXT_TURBOPACK_TRACING` 之类的 trace，确认排除它们后 `server.js` 仍能起。
2. **排除后功能回归**：至少跑 PDF/Docx 上传解析（canvas/pdfjs）、审计导出（pdfkit）、i18n 切语言、
   `/admin` 全页 —— 这些是 tracing 排除最容易误伤的路径。
3. **migration 每次启动的实际耗时**：`docker.cjs` 没有耗时打点，需在冷启动时用
   `docker events`/时间戳测（空库 vs 已迁移库），才能判断 `SKIP_DB_MIGRATION` 值不值得做。
4. **`--max-old-space-size` 的安全下界**：需要在真实负载（并发对话 + 知识库解析）下二分，
   674 MiB idle 说明 1024 可能偏紧，建议先 1536 观察 OOM/GC。
5. **无 Redis 单实例的真实退化面**：`services/home`、`connectorCatalog/runtimeEffectiveState`、
   `platformSystem/statusProjection` 在 Redis 缺失时是否 fail-open，需要跑一遍管理端。
6. **重建镜像后的实际尺寸**：本报告的削减量是 `du` 推算，未实际构建验证（构建需 ≥8 GB 堆 × 4 阶段）。
7. **compose profiles 的 `depends_on` 行为**：profile 未激活时 `condition: service_healthy` 会不会
   直接让 app 起不来，需要实测（Docker Compose 版本相关）。
