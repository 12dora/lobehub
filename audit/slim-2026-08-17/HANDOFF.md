# 部署减负（slim）二期交接 — 给下一位 agent

写于 2026-08-17，一期已上线（main `6d96a15bad`，demo `aihub:slim-final3`）。本文件是二期的**唯一入口**：
读完它 + 引用的报告，就能开工。所有路径相对仓库根。

## 0. 一分钟状态

- 一期做了什么：24 个可关模块 / 3 档预设 / 管理页 `/admin/system/modules`；worker 注册表 + 空转退避；**全部
  lambda/async/tools/mobile 子路由 tRPC `lazy()`** + Docker `experimental.preloadEntriesOnStart:false`；重依赖按需加载；
  9 项热路径缓存；镜像 1.72→1.1GB；首屏 33.8→25.5MB。全文见 [`FINAL_REPORT.md`](./FINAL_REPORT.md)，方案见 [`PLAN.md`](./PLAN.md)，
  运维文档见 [`docs/enterprise/modules.md`](../../docs/enterprise/modules.md)。
- 实测（V1/V2 真机，[`reports/V1.md`](./reports/V1.md)、[`reports/V2.md`](./reports/V2.md)）：空闲 CPU 中位 0%；启动 RSS
  full 271 / standard 236 / minimal 214 MB；典型会话后 340–430 MB；20 并发流式对话 2 分钟：full 与 minimal CPU/延迟一致，
  RSS 峰值 647 vs 551 MB。
- **二期目标**：会话后 RSS 再降 30–50 MB、空闲 DB 往返再降 80%、每条消息少 3–6 次查询、首屏 JS 再降 ~7 MB、镜像增量拉取降到百 MB 级。

> **二期已于 2026-08-18 完成并上线**（main `21d077af6f`，demo 镜像 `aihub:p2-final`，回滚 tag `aihub:demo-prev-p2`）。
> 交付、实测与逐轮复审记录见 [`phase2/`](./phase2/)（`prompts/` 简报与裁决、`reports/` 实施报告、`reviews/` 16 轮 codex 复审）。
> 真机实测（同一台机、同一 perf 库，对照一期镜像 `aihub:slim-final3`）：启动 RSS 294→**236 MB**、首轮请求后 325→**264–312 MB**、
> 空闲 0.611→**0.422 xact/s**（−31%）、镜像 1.9→**1.79 GB**（层拆分 + skia 去重，抵消 cursor-agent 增量）、
> 首屏阻塞 JS 25.67→**24.56 MB**（chat 块 2.23→1.12 MB）；管理端登录 + 7 个页面 0 console error，
> 可见标签页 150 s 内仅 1 次合批 `getCapabilities+getPublicSnapshot`，隐藏标签页 0 请求。
> 各项落地与被否决的方案：P1 见 `phase2/reports/G1.md`、P2 `G2.md`、P3 `G3.md`、P4 `F4.md`（`es-*` 7.4 MB 已证明无法在应用层拆，
> 结论写进 `plugins/vite/sharedRendererConfig.ts` 注释）、P5 `G5.md`、P6 `F6.md`。

## 1. 二期任务（按优先级；每项给出入口 file:line、依据、验收）

### P1 builtin-tools 分包 + aiAgent 静态图瘦身（会话内存最大剩余单点）

- 依据：[`explore/G0_spike.md`](./explore/G0_spike.md) §C 表最后一行、[`reports/G3.md`](./reports/G3.md)（"builtin-tools 留 sync 的原因"）、
  [`explore/E2_modules.md`](./explore/E2_modules.md) B8。
- 现状：`packages/builtin-tools/src/index.ts:1-34` 静态 import 28 个 `builtin-tool-*` 包（≈60k LOC），`defaultToolIds` 只用 12 个；
  `apps/server/src/services/aiAgent/index.ts:22` 与 `apps/server/src/services/toolExecution/serverRuntimes/index.ts` 把它们拉进
  **首个对话请求**的图（`aiAgent` 路由已 lazy，但一次对话就全载）。
- 做法：manifest（元数据，轻）与 runtime（执行体，重）分包；`builtinTools` 数组保持公共导出形状但 manifest 里不再 import 执行体；
  `serverRuntimes/index.ts` 改按 identifier 动态 `import()`（G2 已给 `message` runtime 做了范例：`messageRuntime` lazy factory，
  见 [`reports/G2.md`](./reports/G2.md) Round 2 第 7-8 条）。客户端 `packages/builtin-tools` 的 Render/Inspector 已经是按需 chunk，不用动。
- 先 spike：在 spike 树按 [`explore/G0c_all_lazy.md`](./explore/G0c_all_lazy.md) 的方法量"首个对话请求后"的 RSS/模块数（基线 ~375 MB / ~1500 modules）。
- 验收：会话后 RSS −30 MB 以上；`bunx tsgo` 零新错；`apps/server/src/services/toolExecution` 与 `packages/builtin-tools` 测试绿；
  工具调用 e2e（至少 web-browsing、knowledge-base、memory 三个 runtime）真机跑通。

### P2 `platform_jobs` 合并 dispatcher（空闲 DB 往返再降 ~80%，fork-only）

- 依据：[`explore/E1_runtime.md`](./explore/E1_runtime.md) C2、[`reports/G2.md`](./reports/G2.md) "Optional: single dispatcher" 段（设计已写）。
- 现状：`apps/server/src/enterprise/bootstrap/workersBootstrap.ts` 注册 6 个 `platform_jobs` 轮询 worker（agentRollout 2s / secretRewrap 2s /
  auditExport 3s / auditRetention 3s / connectorRuntimeAudit 5s / connectorSecretCleanup 5s），各自独立连库；一期只加了空转退避到 60s
  （`apps/server/src/enterprise/jobs/persistentWorkerScheduler.ts`）。
- 做法：一个 scheduler 以 `min(interval)` 跑 `SELECT … FOR UPDATE SKIP LOCKED` 取一批混合类型 job，按 type→handler 分派；每 type 保留
  `didWork` 以便整体退避；**不要**把两个 advisory-lock 清理任务（identityProviderTestAttemptCleanup / platformInstanceRegistryCleanup）
  和 mihomo supervisor 折进去。多副本 + PgBouncer 下 LISTEN/NOTIFY 未验证，二期先不做事件驱动。
- 验收：full 档空闲 xact/s 从 0.5–0.9 降到 ≤0.15（V1 §1 方法：`SELECT xact_commit FROM pg_stat_database` 60s 差分）；
  `apps/server/src/enterprise/jobs/*.test.ts` + `auditWorkers.flagOff.test.ts` 绿；模块关掉时对应 type 不被取（测试）。

### P3 每条消息的固定成本（负载维度）

- 依据：[`explore/E5_request_path.md`](./explore/E5_request_path.md) B6/B9（第 10、12 行仍未做）+ V2 §3 负载表。
- 清单：
  1. `apps/server/src/routers/lambda/user.ts:~153-160` `getUserState` 5 路 `Promise.all`（countUpTo/hasMoreThanN/referral/subscription）→ 合并或按需；
  2. `apps/server/src/modules/AgentRuntime/adapters/serverCallLlmContextBuilder.ts:110-131` `resolveTopicReferences` 对每个引用 topic
     2 次 `findById` + 1 次全量 `messageModel.query` → 批量查询；
  3. `apps/server/src/services/aiAgent/index.ts:~3596-3620` 每条消息 1 次 persona 查询 → 请求内 memo（G4 已给 `UserSettingsReadMemo` 范例：
     `apps/server/src/enterprise/services/settings/runtimeSettingsAdapter.ts`）；memory 模块关时应直接跳过；
  4. `packages/context-engine/src/pipeline.ts:65-110` ~50 个 processor 串行 await → 只把无依赖的段并行（先量再改）。
- 上游文件，每处一两行 memo/合并；验收：V1 §3 同款负载测试下 DB xact/s 从 ~23 明显下降、p95 不变。

### P4 首屏 `es-*` 7.4 MB 共享块 + Service Worker precache 收窄

- 依据：[`reports/F2.md`](./reports/F2.md)（Round 2 表、"top follow-up"）、[`reviews/REVIEW_F2.out.md`](./reviews/REVIEW_F2.out.md)。
- 现状：`dist/desktop/assets/es-*.js` 7.4 MB 是入口静态引用的共享 vendor 块（`@lobehub/icons` SVG 数据 + `elkjs` + parse5/hast + `@pierre/diffs`），
  分包配置在 `plugins/vite/sharedRendererConfig.ts`；F2 试过给 shiki 单独分组会**重复打包**（记录在该文件注释+测试里，别再试）。
  workbox 预缓存 1525 chunk / 76 MB（vite PWA 配置）。
- 做法：icons 改按需（或单独 chunk 只在用到的路由载）、elkjs/parse5 移到用到的路由 chunk、precache 只留首屏关键资源；每改一次
  `bun run build:spa:raw` + `ls -la dist/desktop/assets | sort -k5 -n | tail`；用 [`explore/e5`] 同款 Playwright 请求记录（脚本
  `reports/F2.md` 提到的 measure 流程）量"阻塞首屏 JS"。
- 验收：阻塞首屏 JS ≤ 16 MB（今 22.4），运行时全部 JS ≤ 20 MB（今 25.5）；`plugins/vite/*.test.ts` 绿。

### P5 镜像分层 + 原生依赖副本收敛

- 依据：[`explore/E3_docker.md`](./explore/E3_docker.md) B4/B8/C3/C4、[`reports/G5.md`](./reports/G5.md)（硬链接不过 scratch COPY 的记录）。
- 现状：`Dockerfile` 最终 `COPY --from=app / /` 单层 ~944 MB；`@napi-rs/canvas` skia.node ×3（81 MB）、`@img/sharp-libvips` 两版本（33 MB）、
  `ffmpeg-static` 49 MB（只有视频生成用；一期撤回了 `WITH_VIDEO`，因为直接删会 MODULE_NOT_FOUND）。
- 做法：final 段拆 系统+node_modules / app 两层；canvas 副本用 `pnpm dedupe` 或 tracing 只保留 `.pnpm` 那一份并验证
  `require.resolve('@napi-rs/canvas')`；ffmpeg 与 `imageGen` 模块联动（模块关时 `require('ffmpeg-static')` 路径要先门禁再删）。
  **不动**四段结构 / curl-impersonate 段 / `serverExternalPackages` / `dockerCanvasTracingIncludes.ts`（E3 §D）。
- 验收：`docker history` 显示 node_modules 层在只改 app 代码时命中缓存；PDF 解析（canvas）与图片处理（sharp）e2e 通过。

### P6 轮询降频 + 心跳合并（fork-only，一小时）

- 依据：[`explore/E5_request_path.md`](./explore/E5_request_path.md) B5、[`explore/E4_admin_setup.md`](./explore/E4_admin_setup.md) B8。
- 现状：匿名 `platform.getPublicSnapshot` 30s、登录 `platform.getCapabilities` 60s（常量在 `src/enterprise/client/shared/pollIntervals.ts`，
  服务端已 8s 缓存）；实例心跳 30s（`apps/server/src/enterprise/services/platformInstance/heartbeatRuntime.ts`）+ IdP 注册表心跳 30s
  （`services/identityProvider/instanceRegistry.ts`）两条写。
- 做法：轮询只在页面可见时跑、周期 120s、或改成"版本号变化才刷"；两条心跳合并成一条 upsert。
- 验收：一个标签页空闲 5 分钟 ≤3 个请求；`platform_instance_heartbeats` 写频率减半。

### 明确不做（写清理由，避免翻案）

中文两字节放大（要改上游 i18n 装载）、`startServer.js` 父进程 61MB（supervisor 语义）、Shiki（改 `@lobehub/ui`，走上游 PR）、
ParadeDB→普通 PG（产品决定不动）、Rust/C++（负载 profile 无计算密集热点）、heteroAgents 模块化（先解环）。

## 2. 怎么开工（一期跑通的流程，照抄）

1. **不要在主树干活**：另一个会话常年在主树提交。`git worktree add -b feat/slim-phase2 /Users/konata/code/AIHub-worktrees/slim2 origin/main`，
   `cp .env.development` 进去，`pnpm install --prefer-offline`（~1 分钟）。基线 `bunx tsgo --noEmit -p tsconfig.json` 只有 1 个存量错
   （`src/components/mdx/Image.tsx:34`）。
2. **量化 spike 树**：再开一个 worktree（一期用 `AIHub-worktrees/spike`），`DOCKER=true NODE_OPTIONS=--max-old-space-size=7168 bunx next build`
   （只 next，SPA 模板要 stub 两个 html 常量，见 [`explore/G0_spike.md`](./explore/G0_spike.md) §E），起 `node .next/standalone/server.js`
   （PORT 任意，`.env.development`），用 CDP/`Module._cache` 采 boot/首请求/burst 的 RSS 与 chunk 集合——方法与脚本细节在
   G0/G0b/G0c/G0d 四份报告里，"burst" 的 11 条路由列表在 G0c。
3. **agent 分工模板**（一期实测好用）：opus 做探索/前端、grok-4.6(high) 做后端/Docker、codex(gpt-5.6-sol high, read-only) 做复审、
   指挥官裁决。共同规则与契约见 [`prompts/COMMON_RULES.md`](./prompts/COMMON_RULES.md)，复审模板 [`prompts/REVIEW_TEMPLATE.md`](./prompts/REVIEW_TEMPLATE.md)，
   各任务简报 `prompts/*.md` 可改写复用。**给 agent 的路径一律绝对路径**（一期用相对路径，agent 找不到规则文件）。
   grok 模板：`grok --prompt-file <abs> -s <uuid> -m grok-4.6 --reasoning-effort high --always-approve --no-plan --no-memory --output-format plain --cwd <worktree>`
   （nohup + `< /dev/null`），返工 `--resume <uuid>`。codex：`codex exec -m gpt-5.6-sol -c model_reasoning_effort=high -s read-only -C <worktree> --ephemeral --skip-git-repo-check -o <out.md> "$(cat prompt)"`
   （只读沙箱**不能写文件**，用 `-o` 拿最终消息）。zsh 下 `$VAR` 不分词，脚本用 bash。
4. **门禁顺序**：各包定向 vitest → codex 复审 → 裁决返工 → 集中 `bunx tsgo --noEmit`（本仓 ~1 分钟）→ `bun run .agents/scripts/check/cli.ts --lint <files>`
   （`bun run check` 会在无关的 `apps/cli/pnpm-lock.yaml` branding 基线上中断）→ 大范围 vitest（≤10 分钟一批，超时会被 harness 杀；
   `packages/*` 要 `cd` 进包跑；packages/business/model-bank 无 vitest 配置）→ 分组 gitmoji commit（`HUSKY=0 git commit --no-verify`，
   `git add` 精确路径，共享 locale 文件定点插入且三文件键集 parity 测试 `packages/locales/src/default/admin.parity.test.ts` 必须绿）
   → `git rebase origin/main` → 从干净 worktree `AIHub-build-np` `docker build --build-arg USE_CN_MIRROR=true -t aihub:<tag> .`
   （首次 ~25 分钟，层缓存后 ~5 分钟）→ 真机验证 → `git push origin <branch>:main` → demo（`docker tag` 换 `aihub:demo`，
   `docker compose -f ~/.local/share/aihub/demo/docker-compose.app.yml -p aihub-demo up -d --force-recreate`，回滚 tag 先打好）。
5. **真机验证环境**：docker 网络 `aihub-dev_aihub-dev`；测试库 `lobechat_perf`（demo 库的拷贝，`platform_module_settings` 有一行残留可删）；
   Redis db 3；`AUTH_COOKIE_PREFIX=aihub-perf`；账号 admin@aihub.local / user@aihub.local（密码在 `~/.local/share/aihub/secrets/`）；
   Playwright 在 `/Users/konata/code/AIHub/e2e/node_modules/playwright`；V1 的脚本 `run_tier.sh / tier.mjs / s2.mjs / probe.mjs`
   与假 OpenAI 流式服务在一期 scratchpad `uat/`（已随会话消失，报告里有做法，重写约 1 小时）。**不要碰 `aihub-demo-app`(3010) 和 `aihub-dev-*`。**

## 3. 必须知道的坑（一期踩过）

- **Next standalone 里 `instrumentation.ts` 与 route handler 是两份模块拷贝**：模块级变量不共享，跨两边的状态要放 `globalThis`
  （`apps/server/src/enterprise/services/moduleSettings/index.ts` 的 boot 视图）。
- **绝不按模块条件挂载 router**：注册表按对象身份对账（`security/policy/adminProcedureAuthorization/reconcile.ts`），且 NOT_FOUND 在客户端
  会变成永远点不通的重试按钮；一律 always-mount + `PLATFORM_MODULE_DISABLED`（FORBIDDEN）。新 router 用
  `apps/server/src/enterprise/routers/{lazyRouter,moduleRouter}.ts`；泛型返回必须是 `Lazy<NoInfer<T>>`，否则 `router({})` 上下文把 T
  坍缩成 AnyRouter、全部客户端调用类型报错。
- 用户端 `platform.*` 目录读要保持"稳定空目录"（不抛错）：`tests/setup.ts` 把所有 `ENABLE_*` 置 '0'，抛错会让存量测试红，客户端也把空当"未托管"。
- `outputFileTracingExcludes` 里**不能写裸 `dist/**`**（picomatch `contains:true` 会误杀 `next/dist`、`es-toolkit/dist` → tRPC 全 500）；
  列表统一在 `src/libs/next/config/dockerTracingExcludes.ts`。`path.resolve(process.cwd(), <import 常量>)` 会让 Turbopack trace 全仓。
- 上游文件只做一行守卫 / 一行替换 / 一层 memo / `await import()`；测试基线 `ENABLE_*='0'`；`import { mutate } from 'swr'` 在 admin 里是 no-op（用 `@/libs/swr`）。
- codex 噪声：会把 identity/content-addressed memo 也要求 TTL、把 fork 脚本当上游、把 `getBootModules` 的 env-only 回退当 bug——一期
  裁决记录在 [`prompts/*b_rework.md`](./prompts/) 各文件开头，可作为判例。
- 存量红测试（main 同样红）：`platform.mount.regression`（fake db 无 select）、`serverRuntimes/__tests__/memory.test.ts`（schemas mock 缺 topics）、
  `packages/const layoutTokens.test`；高负载并行跑 vitest 时 5s 超时抖动的：adminConnectors.service、taskTemplates modal、
  userListProjection.workspace、regexWorker、agentSkills.integration——单跑都绿。

## 4. 目录索引

- `PLAN.md` 一期方案定稿；`FINAL_REPORT.md` 交付报告；`explore/E1..E5` 五份探索实测；`explore/G0*` 四份构建/内存 spike；
  `reports/G1..G5,F1,F2` 各包实施报告（含 Round 2/3）；`reports/V1,V2` 真机验证；`reviews/` codex 复审；`prompts/` 全部简报与规则。
