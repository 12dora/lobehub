# LobeHub Enhanced 部署减负 / 可选模块方案（slim 批次）— 设计稿 v1

日期 2026-08-17。依据 5 份探索报告（`explore/E1..E5`）。用户已定：docker 参数 + 管理后台页面（保存后重启生效，首次进入引导）；默认全开；Redis/rustfs/searxng 可不装，数据库仍 ParadeDB；单一镜像。

## 0. 热点结论（实测，非推测）

| 热点 | 数字 | 来源 |
|---|---|---|
| next-server 冷启动 RSS 430MB，heap 307MB，其中 **150MB 是 JS 源码字符串**（1876 模块 / 78MB chunk 在 boot 期即 require，占磁盘 chunk 的 63%） | 1MB chunk ≈ 2.5MB RSS | E1 B1/B2 |
| 6 个 root mega-chunk（各 4.14MB，含中文→two-byte 放大到 7.7MB）内含 bot 适配器 / model-bank / i18n / mihomo 客户端等 | 46MB heap | E1 B1 |
| demo 运行后 688MB：+260MB 是按路由懒加载进来的 chunk + 请求缓存 | | E1 B6 |
| **idle CPU 100% 来自 11 个企业后台 worker**（agentRollout 2s / secretRewrap 2s / auditExport 3s / auditRetention 3s / connector×2 5s，成功不退避），它们是 `enterprise/routers/platform.ts:51-81` 的模块顶层副作用 | worker 未起 0.075%+0.2 xact/s → 起后 1.57%+2.35 xact/s | E1 B4 |
| GatewayService（bots）无 flag 常驻，boot 多 3.6s，拉入 discord.js/telegraf/slack 图 | | E1 B3 |
| 镜像 1.72GB：`/app/dist` 270MB 是永不读取的 Vite 中间产物（tracing include/exclude 语义颠倒、excludes 只在 Vercel 生效）；源码/desktop 图标/tsbuildinfo 等 ~60-85MB；ffmpeg 49MB、canvas ×3 副本 | 可砍 ~560MB | E3 B1-B4 |
| 运行时无 `--max-old-space-size`、compose 无 mem_limit | | E3 B5 |
| 侧车 idle RSS：postgres 216 / rustfs 71 / searxng 16 / redis 5 MiB；app 自己占整套 69% | | E3 B6 |
| 浏览器标签页空闲 60s 仅 2 个请求；**冷加载 423 个 JS / 33.8MB**（Shiki 全语言 dep-map 8.1MB、i18n 三语言同下 5.2MB、ErrorContent 1.2MB、TagCloud 1MB 首屏即载） | CPU 峰 110% | E5 B1 |
| per-request：`getServerGlobalConfig` 无 memo（10–17ms/次，首屏 2–3 次）；每 admin procedure 一次 4 表 RBAC join（概览一次加载 10 次）；每 HTTP 请求 1 次 assertUserActive；SWR dedupingInterval=0 → 重复请求 | | E5 B2-B4 |
| per-message：`loadModels()` 每 LLM step 重建 1943 model；AI catalog 快照无缓存且逐行 SHA-256；DomainConfigCache 命中仍 1 次 Redis；egress 快照 clone ×2（含解密订阅 YAML）；审计快照取 2 次；内容审计/egress 包装无开关恒定装载 | | E5 B9 |
| 现有 flag（upstream FEATURE_FLAGS 20 键 / fork ENABLE_PLATFORM_* 8 键）**没有一个能阻止 import/mount/worker**；6 个 fork 模块（内容审计/网络代理/统计/共享 OAuth/任务模板/ChatGPT Web）完全没有开关 | | E2 B1 |

⇒ 减负的杠杆按收益排序：**① 后台 worker 门禁+退避（idle CPU→~0）② 模块化懒加载（boot RSS 大头）③ 镜像/构建裁剪与堆上限 ④ 首屏 bundle ⑤ 请求/消息路径算法修补**。

## 1. 模块模型

### 1.1 三层语义（明确分工，避免 fail-closed 事故）
- **硬开关（boot 期）**：决定 import / worker / 子进程 / gateway 是否启动。来源 = `effective` 在 **进程启动时** 读一次（env + DB 行），进程生命周期内不变；改动 → 页面显示「待重启」。
- **软开关（运行期，热生效，30s 缓存 + Redis 跨实例失效）**：决定 tRPC/webapi 是否放行（抛 `PLATFORM_MODULE_DISABLED`/FORBIDDEN）、`__SERVER_CONFIG__`/capabilities 下发、nav/路由/页面显隐、FEATURE_FLAGS 派生覆盖。
- **effective 规则**：`effective[id] = envDisabled.has(id) ? false : (dbRow?.modules[id] ?? true)`。env 只能**关**不能开（运维用容器参数一定能摁死；管理页对 env 关的模块显示「由环境变量控制」+ 变量名，Switch 禁用）。**行缺失 = 全开**（写测试钉死）。
- 全部 tRPC router **始终挂载**（注册表按对象身份对账 215 条；NOT_FOUND 会变成永远点不通的重试按钮 — E4 B4/B6）。上游可选模块的 router 用 `@trpc/server` `lazy()` 包一层：启用 → 首调时 `import()`；禁用 → 返回同形状 stub，每个 procedure 抛 `PLATFORM_MODULE_DISABLED`。B0 spike 先验证 turbopack 是否真的把 lazy import 切成独立 chunk（决定 ② 的收益上限）。

### 1.2 配置来源
- env：`LOBE_MODULE_PRESET=minimal|standard|full`（默认 full）+ `LOBE_MODULES_DISABLED=a,b,c`（追加禁用；沿用"只有显式才关"）。旧的 `ENABLE_PLATFORM_*` / `FEATURE_FLAGS` 保持原语义（模块层是它们的下一层）。
- DB：新表 `platform_module_settings`（`id='global'` 单例，jsonb `modules: Record<ModuleId, boolean>`，`setupCompletedAt`，CAS `revision`，`updatedBy`），模板 = `platform_auth_settings`；服务 `enterprise/services/moduleSettings/`（`DomainConfigCache` 30s + `publishPlatformConfigInvalidation('modules')`）。手写迁移（drizzle-kit generate 已知损坏），`when` 大于并行会话已用值。
- 常量表 `packages/const/src/platform/modules.ts`：`ModuleId`、`PLATFORM_MODULES`（label key / tier / kind: `hot|restart` / deps / 所属 admin router keys / feature-flag 派生 / 用户端路由前缀）、`CORE_MODULE_IDS`、`MODULE_PRESETS`。

### 1.3 模块清单与预设（档位已定 2026-08-17：用户指出 任务模板/知识库/语音/市场/机器人/高级扩展 相对不重要，其余按重量分档）
kind：hot=保存后刷新即生效；restart=有 boot 期设施，需重启才释放资源。

| # | ModuleId | 归属 | 内容 / 门禁点 | kind | minimal | standard | full |
|---|---|---|---|---|---|---|---|
| U1 | knowledgeBase | 上游 | 知识库/RAG/文件解析/chunk/ragEval 路由（lambda+async）；派生 `knowledge_base=false`；pgvector 表不动 | hot | ✗ | ✗ | ✓ |
| U2 | imageGen | 上游 | 图像/视频生成路由、`sharp`/ffmpeg 懒载；派生 `ai_image=false` | hot | ✗ | ✓ | ✓ |
| U3 | speech | 上游 | TTS/STT；派生 `speech_to_text=false` | hot | ✗ | ✗ | ✓ |
| U4 | webSearch | 上游 | 搜索 provider 集（11 个静态 import）、web-browsing 工具、crawler；searxng 可不装 | hot | ✗ | ✓ | ✓ |
| U5 | market | 上游 | 助理/插件市场、discover、远程拉取；派生 `market=false` | hot | ✗ | ✗ | ✓ |
| U6 | memory | 上游 | 用户记忆（抽取任务、memory 路由） | hot | ✗ | ✓ | ✓ |
| U7 | bots | 上游 | messenger gateway + 9 个平台适配器 + GatewayService + startServer gateway | **restart** | ✗ | ✗ | ✓ |
| U8 | agentSignal | 上游 | agentSignal 服务 24k LOC + workflow hono 挂载 | restart | ✗ | ✗ | ✓ |
| U9 | workflows | 上游 | Upstash workflow catch-all + 9 个 serve route（无 QStash 本就不可用） | hot | ✗ | ✗ | ✓ |
| U10 | sandbox | 上游 | python interpreter / cloud sandbox 工具（需外部 sandbox 服务） | hot | ✗ | ✗ | ✓ |
| U11 | deviceGateway | 上游 | 远程设备/设备控制（需 DEVICE_GATEWAY_URL） | hot | ✗ | ✗ | ✓ |
| F1 | managedAi | fork | 平台托管 AI 服务商/模型目录（管理员集中配 key 的入口） | hot | ✓ | ✓ | ✓ |
| F2 | managedSkills | fork | 平台技能目录 + readiness | hot | ✓ | ✓ | ✓ |
| F3 | managedConnectors | fork | 连接器治理 + 2 个 5s worker + 共享 OAuth keepalive | restart | ✗ | ✓ | ✓ |
| F4 | managedAgents | fork | 平台助理 + agentRollout 2s worker | restart | ✗ | ✓ | ✓ |
| F5 | settingsPolicy | fork | 设置策略（渗入核心 → null-adapter，不卸载） | hot | ✓ | ✓ | ✓ |
| F6 | branding | fork | 运行时品牌 + 5min 资产清理 job（S3） | hot | ✓ | ✓ | ✓ |
| F7 | databaseIdp | fork | DB 身份提供方（钉钉等）+ instanceRegistry 心跳 + IdP 清理 job | restart | ✓ | ✓ | ✓ |
| F8 | audit | fork | 操作日志/实时/会话证据/导出/保全/留存 + 2 个 3s worker（导出需 S3） | restart | ✗ | ✓ | ✓ |
| F9 | moderation | fork | 内容审计（ModelRuntime 包装、regex worker、LLM 裁判） | restart | ✗ | ✓ | ✓ |
| F10 | networkProxy | fork | mihomo 子进程 + supervisor 15s/30s/60s 探针 + egress 包装 | restart | ✗ | ✓ | ✓ |
| F11 | platformStats | fork | 全局统计（重查询） | hot | ✓ | ✓ | ✓ |
| F12 | taskTemplates | fork | 任务模板 | hot | ✗ | ✗ | ✓ |
| F13 | chatgptWeb | fork | ChatGPT Web 服务商（curl-impersonate 传输，静态 import 于 ModelRuntime → 懒载） | restart | ✗ | ✓ | ✓ |
| — | 核心不可关 | | 对话/助理/话题、认证与用户、管理后台骨架（用户/系统状态/通用设置/安全与认证）、实例心跳、AI 服务商 BYOK、文件基础（S3 缺失时上传自动关，沿用上游 `enableUploadFileToServer`） | | ✓ | ✓ | ✓ |
| 不做 | heteroAgents（claude-code/codex 17.8k LOC，泄漏进 `src/utils/modelLabels.ts` 与 store，需先解环）、oidcProvider/telemetry/changelog（上游已有独立开关，只写进预设文档） | | | | | | |

分档逻辑：minimal(2C/4G)=核心 + 无 worker/子进程的轻量企业件（托管 AI、技能、设置策略、品牌、统计、登录方式）；standard(4C/8G)=+ 企业重件（审计/内容审计/网络代理/平台助理/连接器/ChatGPT Web）+ 常用上游件（图像、记忆、联网搜索）；full=全部。预设 = 上表三列；`LOBE_MODULE_PRESET` 只决定**默认值**，`LOBE_MODULES_DISABLED` 与 DB 再叠加。

## 2. 服务端改动（按接缝）

| # | 接缝 | 文件 | 归属 | 形态 |
|---|---|---|---|---|
| S1 | 模块常量/预设/env 解析 | `packages/const/src/platform/modules.ts`（新）、`apps/server/src/enterprise/featureFlags/parseModules.ts`（新） | fork | 纯函数 + 测试 |
| S2 | DB 单例 + 服务 + 缓存失效 + 迁移 | `packages/database/src/schemas/platform/moduleSettings.ts`、`models/platform/moduleSettings.ts`、`enterprise/services/moduleSettings/*`、`migrations/00xx_platform_module_settings.sql` | fork | 照抄 authSettings/infraSettings |
| S3 | boot 快照 | `enterprise/bootstrap/moduleRuntime.ts`（新）：`resolveBootModules()` 在 `instrumentation.register()` 首步 await 一次（env+DB），冻结为进程级；失败 → env-only | fork（instrumentation +3 行 [U]） | |
| S4 | **worker 注册表** | 把 `enterprise/routers/platform.ts:51-81` 与 `admin.ts:48-50`、`globalConfig/index.ts:32` 的顶层副作用整体搬进 `enterprise/bootstrap/workersBootstrap.ts`（`WorkerSpec{name, moduleId, start}` × 14），由 instrumentation 调用（[U] +5 行）；secretRewrap 改为仅 key provider=vault 时启动；修 `platformInstanceRegistryCleanup` 的 ENABLE_DATABASE_OIDC 错配；`ensureConnectorRuntimeCapabilityStateBootstrapped` 保持进程级只跑一次 | fork | 收益：idle CPU 1.5%→~0.1% |
| S5 | **worker idle 退避** | `jobs/persistentWorkerScheduler.ts`：`run()` 返回 `didWork`，连续空转指数退避到 60s，有活立即回落；6 个高频 worker 合并为一个 `platform_jobs` dispatcher 轮询按 type 分派（二期可选） | fork | 算法 |
| S6 | 上游可选 router 懒加载 | `apps/server/src/routers/lambda/index.ts`（async/tools/mobile 同）：`knowledgeBase: moduleRouter('knowledgeBase', () => import('./knowledgeBase'))`，每模块一行；`moduleRouter` helper 放 `src/business/server/moduleRouter.ts`（upstream 预留 edition 缝）；禁用返回抛 `PLATFORM_MODULE_DISABLED` 的同形 stub | [U] 每行替换 + fork helper | 依赖 B0 spike 结论决定"lazy()"还是"仅 guard" |
| S7 | admin 守卫单点 | `enterprise/guards/platformPermission.ts:200` 后按 `path.split('.')[0]` 查 `MODULE_BY_ADMIN_ROUTER_KEY` 抛 `PLATFORM_MODULE_DISABLED`；`platform.*` 用户端子路由同 helper（3-4 处）；错误码入 `errorCodes.ts` + `enterpriseErrors.ts` + registry `module?` 字段（条数不变） | fork | |
| S8 | webapi/Hono 门禁 | `src/server/agent-hono/index.ts:30` 后 `app.use('*', moduleGate)`（前缀映射表在 fork 文件）；`api/workflows` / `api/v1` catch-all 各 3 行早退；`startServer.js` `startGateway` 与 `/api/agent/gateway/start` 按 bots 模块早退 | [U] 小 | |
| S9 | GatewayService | `src/instrumentation.ts:56` 条件 `&& bootModules.bots` | [U] 1 行 | boot -3.6s，图不进内存 |
| S10 | FEATURE_FLAGS 派生 | `apps/server/src/featureFlags/index.ts` 合并层：模块关 → 对应 flag 强制 false（knowledge_base/ai_image/speech_to_text/market）——复用 54 处客户端消费点隐藏 UI，零前端改动 | [U] 数行 | |
| S11 | 包装器按模块注册 | moderation runtimeBridge 注册（`aiCatalog/runtimeBridge.ts:95`）与 egress `setEgressBinding`（`chatgptWeb/transport` 静态 import 链）改为模块开启时才装；chatgptWeb transport 懒载 | fork | 每消息省 2 Redis+2 clone |
| S12 | 能力下发 | `packages/types/src/serverConfig.ts` `EnterprisePublicServerConfig.modules?`（[U] 1 字段）+ `globalConfig/index.ts:133` 填充（[U] 1 行，已是二开区块）；`platform/capabilities.ts` `modules`（fork）；`admin.system.getModules/updateModules`（SYSTEM_OPERATE + reauth + CAS + 审计 + 广播失效 + `pendingRestart` 计算 + 重启复用 `prepareRestart/requestRestart`）；注册表 215→217 | fork | |
| S13 | boot 期重依赖懒载 | 定位谁在 boot 期静态 import `@/server/modules/S3` / `sharp` / `xlsx` / `@xmldom`（构建 trace），改为按需 `import()` | [U] 若干 | 需 spike 定位 |
| S14 | 请求路径算法 | `getServerGlobalConfig` 外层 memo（env 指纹+infra revision，TTL 60s）[U]；`loadModels()` business stub 走 memo 快路径 [fork stub]；request-scope `platformAuth` 缓存挂 ctx [fork]；`assertUserActive` 5s 进程 TTL（ban/invalidate 按 epoch 失效）[fork helper]；`getPublicSnapshot` 5–10s 进程缓存 [fork]；SWR `dedupingInterval` 0→2000 [U 1 行] | 混合 | |
| S15 | 消息路径算法 | AI catalog 快照按 revision 缓存、checksum 只对变更行；`DomainConfigCache` epoch 读 memo（≤1s）；egress 快照只投影 4 字段、去 clone；审计快照取一次；`getUserSettings` 同请求去重；regex worker 规则按版本缓存在 worker 内 | fork | |

## 3. 客户端 / 管理端

| # | 内容 | 文件 | 归属 |
|---|---|---|---|
| C1 | `getModules()` boot 读取（`__SERVER_CONFIG__` 缺失 → 全开，fail-open，避免 vite dev 全关） + serverConfig selector | `src/enterprise/client/boot/`、`src/store/serverConfig/selectors.ts`（[U] 加 1 selector） | |
| C2 | nav/路由/直链降级 | `adminNavMeta.ts` `AdminNavItem.moduleId?` + `filterAdminNavByModules`；`AdminPermissionOutlet` 命中禁用模块 → `AdminModuleDisabledSurface`（由 `AdminFeatureOffSurface` 改造，含「如何启用」副行）；`SystemGeneralPage` tab 门控照抄 canRead 模式 | fork | |
| C3 | 错误码 | `mapEnterpriseError.ts` `PLATFORM_MODULE_DISABLED → action:none` + locale | fork | |
| C4 | **模块页 `/admin/system/modules`** | 新 nav item（SYSTEM_READ/OPERATE），`adminPageCatalog` lazy；**预设只是起点**：三档按钮一键套用后每个模块仍可单独开关（自定义 = 与任一预设不同时显示「自定义」标记）；行=Switch+名称+说明+StatusBadge（运行中/已停用/待重启/由环境变量控制）+ **性能影响标签**（来自常量表 `cost` 元数据：空闲内存 ≈MB / 空闲 CPU（后台任务周期）/ 负载时开销（每条消息 / 每次请求 / 每次出站 的固定成本，如「每条消息 +2 Redis 往返」「用时加载 sharp」「独立子进程 43MB」）+ 外部依赖（S3/Redis/searxng/外部服务））；页面顶部汇总条：当前选择 ⇒ 预计空闲内存 / 后台任务数 / 每条消息附加步骤数 / 需要的配套容器，与三档预设对比；核心模块禁用态；合规模块关闭走 DangerConfirm；保存 = `runAdminMutation` + CAS；restart 组保存后横幅「立即重启」（`restart.supported=false` 时改文案「请在容器编排中重启」）。cost 数字来自 B0/B3 参考构建实测（写死在常量表并注明测量环境，不是运行时探测） | fork | |
| C5 | 首次引导 | `setupCompletedAt` 缺失 → /admin 概览顶部引导卡（3 步：选模块 → 检查基础设施(复用状态页探针) → 完成）CTA `?wizard=1` 进入同一页面的步骤态；完成写标记 | fork | |
| C6 | 用户端路由/入口 | 上游功能 UI 靠 S10 派生 flag 隐藏；fork 用户端入口（任务模板首页接管、受管资源侧栏等）读 capabilities.modules | fork | |
| C7 | 轮询集中常量表 + env 覆盖 | `getPublicSnapshot` 30s / `getCapabilities` 60s / jobs 3s / audit live 4s / networkProxy 15s(加 页面可见+模块启用 门控) / IdP | fork | |
| C8 | 首屏 bundle | Shiki 只打包受支持语言（或 dep-map 按需）；i18n 只加载当前语言（不下 ar）；`ErrorContent`/`TagCloudCanvas` lazy；`ProcessingState/InitializingState` 计时器守卫、`useTask.ts` 重复 interval | [U] vite/组件 | 首屏 −12MB |

## 4. Docker / 部署

| # | 内容 | 文件 | 归属 |
|---|---|---|---|
| D1 | Docker 构建 `outputFileTracingExcludes`：`dist/**`、`apps/desktop/**`、`apps/cli/**`、`e2e/**`、`tests/**`、`*.tsbuildinfo`、重复 migrations；删 define-config 里语义颠倒的 2 条 include；第一轮只排 100% 安全项（`/app/src`、`/app/packages` 待验证） | `next.config.ts`（把 `vercelConfig` 泛化为 docker 分支）、`define-config.ts:44-45` | [U] 数行 |
| D2 | 可选原生依赖 build ARG（ffmpeg / canvas 副本收敛 / sharp-libvips 版本收敛 / devtools 泄漏） | Dockerfile builder 段 + excludes | fork 改造区 |
| D3 | 运行时：`NODE_OPTIONS=--max-old-space-size=${LOBE_NODE_HEAP_MB:-1536}`、`mem_limit`/`cpus` 可配；`SKIP_DB_MIGRATION`、`ENABLE_BOT_GATEWAY` 两个 startServer guard | compose + startServer.js | fork / [U] 3 行 |
| D4 | compose profiles `redis`/`s3`/`search`，`depends_on required:false`，S3 `:?` 改 profile 内校验；`.env.example` 增 `LOBE_MODULE_PRESET`/`LOBE_MODULES_DISABLED`/`LOBE_NODE_HEAP_MB` 与三档说明；README/docs `docs/enterprise/modules.md` | `docker-compose/enhanced/*` | fork |
| D5 | 镜像分层（node/curl-impersonate 不变层 → node_modules → app）| Dockerfile:176-179 | fork 改造区，可选 |
| 不动 | Dockerfile 四段结构、curl-impersonate 段、`serverExternalPackages`、`dockerCanvasTracingIncludes`、`output: standalone`、`serverMinification:false`、`/app/locales`（只可白名单裁）、ParadeDB | | |

## 4b. 高负载视角（用户 2026-08-17 追加：不只看空载）
- 常量表每个模块带两维成本：`idle`（常驻内存估计、后台任务周期）与 `load`（每条消息 / 每次请求 / 每次出站 fetch 的固定成本、是否会额外调用 LLM、是否占用 DB 连接），UI 与文档同源。
- 负载敏感项与对策（已在 S11/S14/S15/C8 内）：内容审计包装每条消息 2 Redis+2 clone（模块关时不装；开时 S15 去重）；分类器=LLM 裁判时每条消息多一轮模型往返（UI 标红「负载敏感」）；egress 快照 clone（S15 只投影 4 字段）；`loadModels()`/`getServerGlobalConfig` 每步重建（memo）；每 admin procedure RBAC join（request-scope 缓存）；每 HTTP 请求 assertUserActive（短 TTL）；首屏 33.8MB bundle → 冷加载 CPU 峰 110%（C8）；6 个高频 worker 与业务查询争 DB 连接（S5 退避 + 合并 dispatcher）。
- 堆上限按负载定：`LOBE_NODE_HEAP_MB` 默认 1536（E3 建议），文档给出各档建议值（minimal 1024 / standard 1536 / full 2048）与 OOM 症状。
- **B3 增加负载对比测试**：用仓库的 mock provider（`packages/agent-mock` 或本地假 OpenAI 流式端点）跑 20 并发流式对话 × 2 分钟 + 管理端概览轮询，分别在 full / standard / minimal 三档采 CPU/RSS/DB xact/p95 延迟，对比 E1/E5 基线；结果回填到常量表 `cost` 与 `docs/enterprise/modules.md`。

## 5. 不做 / 明确排除
- ParadeDB → 普通 PG（用户已定不动）；heteroAgents 模块化（先解环，下轮）；`startServer.js` 父进程 61MB 合并（restart 语义依赖 compose，收益/风险比低）；LISTEN/NOTIFY 事件驱动 worker（二期）；FEATURE_FLAGS 扩展承载模块（Redis 可变 + userId 灰度语义，不适合 import 期决策）；条件挂载 router；动 `src/spa/router/*` 三份配置；改 `heartbeatRuntime` 的 edge 判断。
- **Rust 重写**（用户提问）：本轮实测的"重"是 ①被加载的 JS 模块图（内存）②DB 轮询（idle CPU）③首屏 bundle（浏览器 CPU）——都不是计算密集，Rust 换不来收益，反而引入 linux x64/arm64 + darwin 三平台原生构建矩阵与上游合并负担。仓库里唯一 CPU 密集的常驻件 mihomo 已是 Go 原生。**候选**（等 W1 落地后按新的 CPU profile 决定，二期）：内容审计正则/关键词匹配（已在 worker_threads，可换 napi-rs `regex` + Aho-Corasick）、文档解析/分块（`file-loaders` + `@napi-rs/canvas` 已是原生）、token 估算（`tokenx` 纯 JS，O(n) 正则，1–3ms/十万字符，不值得）。结论：本轮不做，写入二期候选。

## 6. 实施波次（激进并行，互斥文件集）

- **B0（我 + 1 grok spike，30 min）**：我手写 `packages/const/src/platform/modules.ts`（ID/预设/映射，作为所有 agent 的契约）+ `COMMON_RULES.md`；grok G0 在干净 worktree 做 lazy() 分 chunk 验证构建（`DOCKER=true next build`：把 2 个 router 换成 lazy → 对比 `.next/server/chunks` 与 boot 期 require 集合），并定位 boot 期 sharp/S3/xlsx 的静态 import 源。
- **B1（并行）**
  - grok G1 [S1-S3, S7, S12 后端]：env 解析、表/迁移/服务/缓存、boot 快照、admin.system getModules/updateModules + restart、守卫单点、错误码、注册表、测试。
  - grok G2 [S4, S5, S9, S8, S11]：worker 注册表 + 退避 + instrumentation/startServer/agent-hono 门禁 + 包装器按模块注册。
  - grok G3 [S6, S10, S13]：上游 root router 懒加载/stub、FEATURE_FLAGS 派生、boot 期重依赖懒载（依 B0 结论）。
  - grok G4 [S14, S15]：请求/消息路径算法修补（fork 侧优先，upstream 的 memo/dedupe 三处）。
  - grok G5 [D1-D5]：Docker/compose/文档 + 在 build 机验证镜像尺寸与启动。
  - opus5 F1 [C1-C7]：模块页 + 向导态 + 降级 + 轮询表（先 mock 契约，G1 落地后对接）。
  - opus5 F2 [C8]：首屏 bundle（Shiki/i18n/lazy/计时器守卫）。
- **B2**：codex 逐包 CR（读 REVIEW_TEMPLATE）→ 我裁决 → 返工；集中 `tsgo --noEmit`；`bun run check <files>`；pg 真库测试（`--no-file-parallelism`）。
- **B3**：docker build（干净 worktree `AIHub-build-np`）→ 独立端口实例三档实测（RSS/CPU/xact/boot 时间，与 E1 基线对比）→ Playwright e2e：minimal 档管理端各页 0 error、禁用模块直链显示「模块未启用」、模块页保存/重启/首次引导 → demo 上线 + 回滚 tag → push。
- 提交纪律：按包 gitmoji commit，`--no-verify`，`git add` 精确到文件；locale/registry 等共享文件按 hunk 暂存；并行会话在同树，跑 check 前看 git status。

## 7. 验收指标（可量化）
- idle：next-server CPU ≤0.2%（今 1.5%），DB xact/s ≤0.3（今 2.3）。
- boot RSS：full ≈ 今 430MB（不退化）；standard ≤ 350MB；minimal ≤ 280MB（依 B0 spike 修正）。
- 镜像 ≤ 1.2GB（今 1.72GB）。
- 首屏 JS ≤ 22MB（今 33.8MB）。
- 关闭任一模块后：管理端全部路由 0 console/page error；nav 隐藏；直链显示模块未启用；对应 tRPC 返回 FORBIDDEN/PLATFORM_MODULE_DISABLED（非 404）。
- 默认（不配置）行为与今天一致（现网升级零变化）。
