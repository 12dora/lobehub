# E5 — 请求路径与客户端驱动负载（per-request 成本 / 轮询 / 缓存 / 算法热点）

测量环境：demo 容器 `aihub-demo-app`（image `aihub:demo`），Playwright 真机驱动，管理员账号
`admin@aihub.local`。原始数据与脚本在 `scratchpad/slim/explore/e5_raw/`
（`measure.mjs` / `measure2.mjs` / `timing.mjs` / `requests.json` / `requests2.json` / `dockerstats.tsv`）。

---

## A. Summary（≤15 行，给指挥官做决策）

1. **空闲成本极低，"重"不在 per-request**：一个登录后的浏览器标签页静置 60s，只产生 **2 个 tRPC 请求**
   （`platform.getPublicSnapshot` 30s + `platform.getCapabilities` 60s）。容器 CPU 中位数 **0.62%**、
   p90 **2.39%**（100 个 3s 采样），RSS 全程 674→681MB 不涨。**结论：削减内存/常驻模块的收益 >> 优化请求路径。**
2. 真正的尖峰在**页面冷加载**：一次 chat 首页加载 = **423 个 JS 文件请求 / 33.8MB 未压缩 JS**，
   CPU 单点冲到 **109.9%**（1.1 core）。这是用户体感"卡/重"的主因。
3. 单个 8.1MB chunk `assets/es-CAULdSB8.js` = **Shiki 语法高亮的全语言 dep-map**，在 chat 首页即被加载。
4. i18n 在首屏同时下载了 `i18n-src`(2.4MB) + `en-US`(0.96MB) + `zh-CN`(0.91MB) + **`ar`(0.91MB)**，
   ~5.2MB 只需 ~1MB。`dist/desktop/i18n` 共 25.4MB。
5. `dedupingInterval` 全局默认 **0**（`src/libs/swr/index.ts:28`），导致一次加载里
   `config.getGlobalConfig` 打 2 次、`aiProvider.getAiProviderRuntimeState` 打 3 次。
6. `getServerGlobalConfig()` **无任何 memo**，每次调用重建 86 个 provider / 45k 行 model-bank 的配置
   （实测 10–17ms，是其他 procedure 的 3–5 倍）。
7. fork-only 的鉴权税：每个 HTTP 请求多一次 `assertUserActive` users 查询；**每个 admin procedure**
   多一次 4 表 RBAC join（demo 管理员返回 70 行）。admin 概览一次加载 = **10 次同样的 join**。
8. `platform.getPublicSnapshot` 是**全局唯一的匿名可达轮询**（登录页也在打），每次 2–3 次 DB 读，无 per-process 短 TTL 缓存。
9. 服务端内存缓存整体健康：settings / catalog 缓存都有 LRU 上限与 TTL（见 B7），**不是**泄漏源。
10. Admin 高频轮询（jobs 3s、audit live 4s、network-proxy 15s）**默认不触发**——实测打开
    `/admin/system/status` 与 `/admin/audit/live` 静置 60s 仍只有那 2 个全局请求（需手动开 live/有 job 在跑才启动）。
11. **聊天路径的 per-message 固定成本（静态分析，见 B9）另有 5 个明确浪费**：`loadModels()` 每个 LLM step
    重建 1943 个 model（~2MB 垃圾）；平台 AI catalog 快照无缓存且对每个 provider payload 做 SHA-256；
    `DomainConfigCache` 每次命中仍打一次 Redis；网络代理快照（含解密后的订阅 YAML）每次出站 fetch 被
    `structuredClone` 两次；审计快照每条消息取两次。
12. 建议优先级：客户端 bundle 瘦身（Shiki + i18n + 懒加载）> `loadModels()`/`getGlobalConfig` 记忆化
    > catalog 快照缓存 + Redis epoch memo > 请求内 RBAC/session 缓存 > 关闭 `getPublicSnapshot` 轮询。
13. 可做成 toggle 的：Shiki 语言集、i18n 语言集、`platform.getPublicSnapshot` 轮询周期、admin 轮询周期、
    **内容审计包装**（当前无 env 开关，`mode:'off'` 也要付 2 次 Redis+2 次 clone）、**egress 包装**（同样无开关）。
14. `resolveEgress` 的**决策**很便宜，但它的**快照克隆**不便宜（B9-4）——关模块的性能理由成立，但优先修 clone。
15. 需要触碰的 upstream 文件极少：`src/libs/swr/index.ts`（1 个默认值）、Vite 的 Shiki/i18n 分包配置、
    `apps/server/src/globalConfig/index.ts` 与 `packages/model-bank/src/aiModels/index.ts`（各加一层 memo）。

---

## B. Findings by importance

### B1. 客户端首屏：423 个 JS 请求 / 33.8MB（最重，upstream 构建配置）

实测（`requests.json`，phase `chat-home:load`）：

| 阶段 | 总请求 | 其中 script | 唯一 script 文件 | 磁盘未压缩总量 |
|---|---|---|---|---|
| 登录页 + 登录 | 496 | 468 | — | — |
| chat 首页冷加载 | 442 | 423 | 423 | **33,831,042 B (32.3MB)** |
| /admin 概览冷加载 | 383 | 365 | — | — |
| /admin/system/status | 379 | 363 | — | — |
| /admin/audit/live | 380 | 364 | — | — |

统计方法：`home_scripts.txt` → 映射到容器 `/app/dist/desktop/**` → `stat -c %s` 求和
（脚本见 `e5_raw/analyze.mjs` 与 shell 记录）。auth SPA 部分仅 7.7KB，其余全在主 SPA。

首屏 top chunks（容器内 `stat`）：

| 大小 | 文件 | 是什么 |
|---|---|---|
| 8.10 MB | `/app/dist/desktop/assets/es-CAULdSB8.js` | Shiki `__vite__mapDeps` 全语言/主题清单（`abap`、`actionscript-3`… 数百项） |
| 2.46 MB | `i18n/i18n-src-*.js` | i18n 源命名空间 |
| 2.34 MB | `assets/chat-*.js` | chat 主包 |
| 2.11 MB | `vendor/vendor-ai-runtime-*.js` | model-runtime |
| 1.62 MB | `assets/index-*.js` | SPA entry |
| 1.35 MB | `assets/es-DhLOxMgQ.js` | 另一个 vendor es 包 |
| 1.23 MB | `assets/ErrorContent-*.js` | 错误页（首屏即载） |
| 1.01 MB | `assets/TagCloudCanvas-*.js` | 词云（首屏即载） |
| 0.96 / 0.91 / 0.91 MB | `i18n-en-US` / `i18n-ar` / `i18n-zh-CN` | **三种语言同时下载**，`ar` 完全无用 |

镜像内构建产物总量：`/app/dist` 270MB = desktop 117.8MB + mobile 113.8MB + auth 38.5MB；
其中 `desktop/i18n` 25.4MB、`desktop/assets` 50.0MB。移动端 113.8MB 在纯桌面部署里是纯占用
（与 E3 的镜像瘦身议题重合）。

Admin 代码分包是**好的**：`useAdminGlobalToolScope` 17.7KB、`useAdminSkills` 14.7KB、
`AdminPageTemplate` 1.9KB…（容器内 `find /app/dist/desktop -iname '*dmin*'`），
admin 页面不会拖累普通用户首屏。

### B2. SWR 全局 `dedupingInterval: 0` 造成同一 key 重复请求（upstream，1 行）

`src/libs/swr/index.ts:28` — `useClientDataSWR` 默认 `dedupingInterval: 0`。实测同一次首页加载中：

- `config.getGlobalConfig` × **2**
- `aiProvider.getAiProviderRuntimeState` × **3**
- `user.getUserState` × **2**（登录阶段 3 次）

（`requests2.json`，phase `home:load`）。`config.getGlobalConfig` 单次实测 **10–17ms**
（`timing.mjs`，4 次采样 17/14/10/11ms），是同批其他 procedure（7–9ms）的 1.5–2.4 倍。

### B3. `getServerGlobalConfig()` 每次调用重建 86-provider 配置（upstream，无缓存）

`apps/server/src/globalConfig/index.ts:53` → `genServerAiProviderConfig.ts:25`
`genServerAiProvidersConfig()`：对 `Object.values(ModelProvider)`（86 个 provider）做 `Promise.all`，
每个 provider 再并行跑 `extractEnabledModels` + `transformToAiModelList`
（`genServerAiProviderConfig.ts:47-58`）。model-bank 规模：`packages/model-bank/src/aiModels` **86 个文件 /
45,442 行 / 2.1MB 源码**。

调用点：`apps/server/src/routers/lambda/config/index.ts:66`、`routers/lambda/aiProvider.ts:33`、
`routers/lambda/aiModel.ts:62`、`services/memory/userMemory/extract.ts:759`。
`grep -n "memo\|cache" apps/server/src/globalConfig/index.ts` 无命中 → **无进程级记忆化**。
输入只依赖 `process.env` + infra snapshot，天然可缓存。

### B4. fork-only 的 per-request 鉴权税

| 环节 | 频率 | 查询 | 证据 |
|---|---|---|---|
| better-auth `getSession` | 每 HTTP 请求 | cookieCache 120s 命中时 0 次 DB，未命中走 Redis secondaryStorage / DB | `packages/trpc/src/lambda/context.ts:337`；`src/libs/better-auth/define-config.ts:259-263`（`cookieCache maxAge 2*60`）、`:271` secondaryStorage |
| **`assertUserActive`（fork）** | **每 HTTP 请求**（`securityOn` 默认开） | 1× `SELECT … FROM users WHERE id=$1 LIMIT 1` | `packages/trpc/src/lambda/context.ts:355-361`；实现 `src/libs/oidc-provider/access-control.ts:126-136` |
| **`withPlatformPermission`（fork）** | **每个 admin procedure**（不是每 HTTP 请求） | 1× 4 表 join `rbac_user_roles ⋈ rbac_roles ⋈ rbac_role_permissions ⋈ rbac_permissions`，返回该用户全部权限 | `apps/server/src/enterprise/guards/platformPermission.ts:203`（`loadPlatformAuthContext`）→ `packages/database/src/models/rbac.ts:343-366` |

实测行数（demo 库 `lobechat_demo`）：`rbac_permissions` 71 行；管理员经角色可得 **70** 个权限
→ 每次 join 返回 70 行。

**放大效应**：tRPC 用 `httpBatchLink`（`packages/trpc/src/client/lambda.ts:153`），
context 每 HTTP 请求跑 1 次，但 middleware 每 procedure 跑 1 次。实测 admin 概览一次加载发出：

```
1× batch: admin.stats.userTotals, countMessages, countTopics, countAgents,
          usageDailyTokenTotals, activitySeries, getMaxTaskDuration, rankUsers, rankModels   (9 个)
1× admin.stats.rankAgents                                                                     (1 个)
1× batch: admin.auth.getMyAccess, platform.getCapabilities, platform.getPublicSnapshot
```

→ **同一个用户、同一毫秒内跑 10 次完全相同的 RBAC join（700 行输出）**，外加各 stats 自身的聚合查询。
`loadPlatformAuthContext` 无任何 request-scope 缓存。

### B5. 常驻轮询（实测 + 静态）

实测（60s 静置窗口，`requests.json` / `requests2.json`）：

| 页面 | 60s 内请求数 | 内容 |
|---|---|---|
| chat 首页 | **2** | `platform.getCapabilities` ×1、`platform.getPublicSnapshot` ×1 |
| /admin 概览 | **2** | 同上 |
| /admin/system/status | **2** | 同上 |
| /admin/audit/live | **1**（批） | `platform.getCapabilities,platform.getPublicSnapshot` |

静态（周期与触发，来源：本批并行子代理的全仓扫描，逐条 file:line 已核对）：

| 源 | 周期 ms | 触发 | file:line | fork/upstream |
|---|---|---|---|---|
| `platform.getPublicSnapshot` | **30000** | SWR `refreshInterval`，**匿名页也跑** | `src/enterprise/client/providers/useEnterprisePlatformData.ts:129`（常量 :20） | fork |
| `platform.getCapabilities` | **60000** | SWR `refreshInterval` | 同上 `:119`（常量 :27） | fork |
| admin system jobs `system.getJobs` | 3000（有 job 时）＋每 tick 追加 `refreshAuthority()` | SWR | `src/enterprise/client/features/admin/system/hooks/useAdminSystem.ts:200,205-210` | fork |
| audit live 列表 + 消息体 | 4000 ×2（需开 live，且 `pageVisible` 门控） | SWR | `src/enterprise/client/features/admin/audit/live/LivePage.tsx:237,260`；常量 `.../audit/shared/useCursorPagination.ts:6` | fork |
| network proxy 状态 | **15000，无条件** | SWR | `src/enterprise/client/features/admin/networkProxy/hooks.ts:42`（常量 :25） | fork |
| IdP 测试/快照状态 | 1500 / 2000（poll 时） | SWR | `src/enterprise/client/features/admin/identityProviders/useIdentityProviders.ts:37,49` | fork |
| 编辑锁 viewer peek | **10000，仅"看"也在打** | `setInterval` | `src/features/EditLock/useEditLock.ts:166-167`；常量 `src/const/documentLock.ts:20` | upstream |
| inbox 未读数 | 60000 | `useClientPollingSWR` | `src/routes/(main)/home/_layout/Header/components/useInboxUnreadCount.ts:21` | upstream |
| Tasks `ProcessingState` 假进度 | 30000，**`useEffect(…,[])` 无守卫** | `setInterval` | `src/features/Conversation/Messages/Tasks/shared/ProcessingState.tsx:163` | upstream |
| Tasks `InitializingState` 计时 | 1000，**无守卫** | `setInterval` | `src/features/Conversation/Messages/Tasks/shared/InitializingState.tsx:63` | upstream |
| 工具 Inspector 执行计时 | **100** | `setInterval` | `src/features/Conversation/Messages/AssistantGroup/Tool/Inspector/ExecutionTime.tsx:67` | upstream |
| memory 分析任务 | SWR 30000 **且** 冗余 `setInterval mutate` 5000 | 两处叠加 | `src/routes/(main)/memory/features/MemoryAnalysis/useTask.ts:14` 与 `:29` | upstream |
| agent 网关 WS 心跳 | 30000（仅活跃 run） | `setInterval` | `packages/agent-gateway-client/src/client.ts:393` | upstream |

补充事实：无 `navigator.sendBeacon`；无客户端 `/api/health` 轮询；
`PLATFORM_INSTANCE_HEARTBEAT_INTERVAL_MS = 30_000`（`packages/database/src/repositories/platformInstance/index.ts:34`）
是 server→server，浏览器不参与。

### B6. 服务端 per-call 成本明细

- `platform.getPublicSnapshot`（`apps/server/src/enterprise/routers/platform.ts:173`）→
  `services/branding/resolvePublicSnapshot.ts:36`：**3 次串行读**——published branding
  （有 epoch+TTL 缓存，`services/branding/publishedReadService.ts:90-102` → `enterprise/runtimeConfig/domainCache.ts`）、
  `PlatformAuthSettingsModel.get()`、`loadPublishedIdentityTarget()`。实测 7–8ms。
  **它是唯一匿名可达的常驻轮询**，登录页开着也在打。
- `platform.getCapabilities`（`platform.ts:144`）：RBAC `hasGlobalPermission`（同 4 表 join）
  + `resolvePublishedManagedResourcePolicies`（就绪探针走 `resolveManagedResourceReadinessCached`，
  代码注释明写 "Every mounted client polls this endpoint"）+ `isPlatformAiTakeoverActive`。实测 7–8ms。
- `user.getUserState`（`apps/server/src/routers/lambda/user.ts:122`）：5 路 `Promise.all`
  （getUserState / countUpTo(5) / hasMoreThanN(1) / referral / subscription，`:153-160`）
  ＋ fork 的 `loadEffectiveUserSettings`（`:169`）＋ `after()` 里的 `advanceLastActiveAt` 写。实测 7–8ms。
- feature flags 不是热点：`FEATURE_FLAGS_DOMAIN.cacheTtlMs = 5000`
  （`apps/server/src/featureFlags/index.ts:26`），用户级 override 30s（`:32-42`），Redis 读被 TTL 摊薄。
- 网络代理 `resolveEgress`（`apps/server/src/enterprise/services/networkProxy/egress/router.ts:143`）
  走 TTL 快照 + 进程内 `getEngineState()`，**每次出站 fetch 的额外成本可忽略**，不构成关闭理由。

### B7. 服务端内存缓存审查：健康，不是泄漏源

逐个核对了模块级 Map（`grep '^const … = new Map'`，40+ 处），关键的都有界：

- `apps/server/src/enterprise/services/settings/effectiveSettingsCache.ts:31,50,83` —
  softCache TTL 5s + `SOFT_CACHE_MAX_ENTRIES=512`（:34）；publishedPolicies LRU 16（:52）；
  resolvedByLayer LRU 64（:85），三者都有显式淘汰循环（:104-110 等）。
- `apps/server/src/enterprise/services/skillCatalog/readService.ts:68,78`、
  `connectorCatalog/catalogSnapshot.ts:72`、`aiCatalog/runtimeAdapter.ts:53` 按 revision key，
  随发布次数增长但每次发布只加 1 个 key。
- 客户端有几个无界 Map（`src/enterprise/client/features/admin/stats/adminStatsDataSource.ts:10,13,16`），
  只在管理员标签页生命周期内，量级可忽略。

**结论：不要把内存问题归到这些缓存上**；E1 的常驻模块/依赖图才是 700MB RSS 的来源。

### B9. 聊天路径 per-message 固定成本（静态分析，未跑真实对话 → 见 E1）

入口 `src/app/(backend)/webapi/chat/[provider]/route.ts:18-42` → `initModelRuntimeFromDB` → `modelRuntime.chat`。

**不是问题的**（澄清，避免误伤）：
- `DEFAULT_MODEL_PROVIDER_LIST`（`packages/model-bank/src/modelProviders/index.ts:146`）是模块常量，
  **不会**每请求重建/深拷贝/zod 解析；服务端只做 `.find()`（`ModelRuntime/index.ts:725`）。
- **没有 tiktoken/WASM**：`packages/utils/src/tokenizer/index.ts:1-7` 用 `tokenx` 纯 JS 估算；
  per-step 的 `countContextTokens`（`packages/context-engine/src/tokenAccounting/index.ts:97`）
  是 O(prompt 字符数) 正则扫描，10 万字符约 1–3ms。
- **聊天路径没有审计证据写入**：所有 `PlatformAuditLogModel.append` 调用方都是 admin 面
  （`enterprise/services/audit/*`、`guards/*`）；会话审计是读侧按需查 `messages` 表。
- 记忆：`apps/server/src/services/aiAgent/index.ts:3596-3620` 每条消息 1 次 persona 查询，
  **无 embedding、无向量检索**；抽取是异步任务。

**是问题的（按可省成本排序）**：

| # | 每条消息/每个 LLM step 做了什么 | 量级 | file:line | fork/upstream | 类型 |
|---|---|---|---|---|---|
| 1 | `loadModels()` 每次重建全量 model list：1943 个对象展开 + 86 次 `Array.concat`。business stub 恒传 `providerLoaders`，**永远走不到 memo 快路径** | ~1943 次分配 / ~2MB 垃圾 **每 LLM step** | `packages/model-bank/src/aiModels/index.ts:219-228`；触发点 `src/business/client/model-bank/loadModels.ts:1`；调用 `apps/server/src/modules/AgentRuntime/adapters/serverCallLlmContextHints.ts:49-50`、`apps/server/src/services/aiAgent/index.ts:2521-2522` | upstream loader + fork stub | 算法 |
| 2 | `loadCurrentAiCatalogSnapshot` **完全无缓存**：join 出每个已发布 provider 的完整 revision jsonb，再对**每一行**做 `checksumPayload`（键排序 + `JSON.stringify` + SHA-256） | 20 provider × 50KB ≈ 1MB stringify+hash / 消息 | `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:57-110`（经 `aiCatalog/runtimeAdapter.ts:220-239`）；checksum `packages/database/src/models/platform/checksum.ts:7-21` | **fork-only** | 算法 |
| 3 | `DomainConfigCache.get()` **即使缓存命中也要先 await 一次 Redis epoch 读**（`getScopeVersion` 无 memo），再 `structuredClone` | 每条消息 ≥3 次 Redis RTT（审计 2 + egress ≥1） | `apps/server/src/enterprise/runtimeConfig/domainCache.ts:143-176`；`enterprise/services/platformConfigInvalidation.ts:208-221` | **fork-only** | 算法 |
| 4 | 网络代理快照被 `structuredClone` **两次/每次出站 fetch**，且快照里带**解密后的 mihomo 订阅 YAML**（上限 50 订阅 × 8MB） | 实际 50KB–1MB × 2 / fetch | `apps/server/src/enterprise/services/networkProxy/snapshot.ts:273` + `runtimeConfig/domainCache.ts:175`；消费方只用 4 个字段（`egress/deps.ts:11-16`） | **fork-only** | 算法 |
| 5 | 审计快照每条消息取 **2 次**（wrapper 一次、`evaluatePrompt` 内又一次） | 2×（Redis GET + structuredClone） | `enterprise/services/contentModeration/runtime/moderationAwareRuntime.ts:194` 与 `contentModeration/decisionService.ts:298` | **fork-only** | 算法 |
| 6 | 内容审计包装**没有 env 开关**，恒定注册；`mode:'off'`（默认）仍要付 #5 的成本才知道要跳过 | 2 Redis + 2 clone / 消息（零 DB） | `enterprise/services/aiCatalog/runtimeBridge.ts:95`（无条件注册，经 `globalConfig/index.ts:32`）；仅 `ctx.skipModeration` 可绕（`moderationAwareRuntime.ts:411-419`） | **fork-only** | toggle |
| 7 | egress 包装同样恒定装载：`ModelRuntime/index.ts:32` → `chatgptWeb/transport/index.ts:3` → `networkProxy/egress/scope.ts:150-167` 的 `setEgressBinding`，因此 `getEgressHook()` 永不为空 | 每个 ModelRuntime 都被 Proxy 包裹 | 同左 | **fork-only** | toggle |
| 8 | 审计开启后：`persistHourly` 每个非复用决策 ≥1 次 DB upsert；`recordNonHits:true` 再 +1 SELECT +1 INSERT；决策缓存查的是**DB 表** | 1–5 查询/消息（在响应路径外） | `contentModeration/recorder.ts:172-255`；`decisionService.ts:345-352` | fork-only | toggle |
| 9 | 审计开启且 `classifier.kind !== 'none'`：**每条消息一次额外 LLM 调用 / Moderations HTTP 调用**（默认 `'none'`） | 一整轮模型往返 | `contentModeration/classifiers/llmJudge.ts` / `moderationsApi.ts`；`decisionService.ts:353-375` | fork-only | toggle |
| 10 | 同一条消息里 `userModel.getUserSettings()` 被查 **2 次**（记忆设置一次、时区一次） | 2 次相同 SELECT | `apps/server/src/services/aiAgent/index.ts:2440-2452`（经 `enterprise/services/settings/runtimeSettingsAdapter.ts:142-161`） | fork adapter + upstream 调用点 | 算法 |
| 11 | 正则审计 worker 是**懒创建的模块单例、会复用**（不是每消息 spawn），但每条消息都把**全部 regex 规则** structured-clone 给 worker；50ms 超时会 `killWorker()`，下一条消息重付 ~20–40ms spawn | | `contentModeration/regexWorker.ts:149,184-206,238-257`；熔断 `keywordMatcher.ts:26,166-179` | fork-only | 算法 |
| 12 | 上下文引擎每个 LLM step 串行 `await` ~50 个 processor；其中 `resolveTopicReferences` 对每个被引用 topic 做 **2 次 `findById` + 1 次全量 `messageModel.query`** | 随引用 topic 数放大 | `packages/context-engine/src/pipeline.ts:65-110`；`apps/server/src/modules/AgentRuntime/adapters/serverCallLlmContextBuilder.ts:110-131` | upstream | 算法 |

model-bank 静态规模（供估算）：87 个 provider 文件 + 86 个 aiModels 文件，51,442 行，`aiModels` 源码 1.6MB，
**1943 个 model 条目**。

### B8. CPU 实测

`docker stats` 100 个 3s 采样（登录 + 4 个页面各静置 60s）：
中位 **0.62%**、均值 2.04%、p90 **2.39%**、峰值 **109.88%**（页面冷加载瞬间）。
RSS 674.2MiB → 681.3MiB，全程无增长趋势（`e5_raw/dockerstats.tsv`）。

---

## C. Recommended seams（最少改动 / 对 upstream merge 友好）

按 (预期收益 × 易度) 排序 = **本报告的 top-10 优化清单**。"类型"列区分
**算法**（改缓存/算法，对所有部署都省）与 **toggle**（做成可关模块）。

| # | 优化 | 类型 | 位置 | upstream/fork | 预期收益 |
|---|---|---|---|---|---|
| 1 | **memo `loadModels()`**（模块级、按 providerLoaders 指纹缓存），消除每个 LLM step 重建 1943 个 model | 算法 | `packages/model-bank/src/aiModels/index.ts:219-228`（缓存加在这里最省事） | upstream（1 个文件，~10 行） | 每 LLM step −~2MB 分配 / −1943 次对象展开；**单项收益最高、改动最小** |
| 2 | Shiki 只打包受支持语言集（或把 dep-map 移出首屏 chunk 改按需 import） | 算法/构建 | `assets/es-CAULdSB8.js` 的产出源 = Vite/rolldown 分包 + shiki `bundledLanguages` 引入点 | upstream 构建配置 | 首屏 −8.1MB（−24% JS） |
| 3 | i18n 只加载当前语言（首屏现在同时拉 en-US + zh-CN + ar） | 算法/构建 | `dist/desktop/i18n/*` 的产出源（i18n 资源 import 图） | upstream | 首屏 −1.8MB；镜像 `i18n` 目录按 `LOCALES` env 裁剪 −25MB |
| 4 | `loadCurrentAiCatalogSnapshot` 套 `DomainConfigCache`（其余同类服务都已经这么做） | 算法 | `apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:57-110` | **fork-only** | 每条消息 −1 次多表 join −~1MB `JSON.stringify`+SHA-256 |
| 5 | `DomainConfigCache` 的 epoch 读 memo ~1s；顺带把审计快照在一次消息内传递而非取两次 | 算法 | `apps/server/src/enterprise/runtimeConfig/domainCache.ts:143-176`、`enterprise/services/platformConfigInvalidation.ts:208-221`；`contentModeration/decisionService.ts:298` | **fork-only** | 每条消息 −3 次 Redis RTT、−2 次 structuredClone |
| 6 | egress 快照视图只保留 `deps.ts:11-16` 需要的 4 个字段（去掉 `subscriptions` 的解密 YAML），并避免二次 clone | 算法 | `enterprise/services/networkProxy/snapshot.ts:268-285` | **fork-only** | 每次出站 fetch −(50KB–1MB)×2 深拷贝 |
| 7 | `getServerGlobalConfig()` 加进程级 memo（key = env 指纹 + infra snapshot revision，TTL 30–60s） | 算法 | `apps/server/src/globalConfig/index.ts:53` **外面**包一层，不改函数体 | upstream（~15 行） | 每次调用 −10~17ms；首屏 2–3 次 → 近似 0 |
| 8 | tRPC request-scope 缓存 `platformAuth`：一个 HTTP 请求里只跑一次 RBAC join | 算法 | `apps/server/src/enterprise/guards/platformPermission.ts:203`（结果挂 `ctx`，middleware 先查 ctx） | **fork-only** | admin 概览一次加载 10 次 join → 1 次（−9×70 行） |
| 9 | **给内容审计 + egress 包装各加一个 env kill-switch**（当前两者恒定装载，`mode:'off'` 也要付快照成本） | toggle | `enterprise/services/aiCatalog/runtimeBridge.ts:95`；`enterprise/services/networkProxy/egress/scope.ts:150-167`（经 `ModelRuntime/index.ts:32` → `chatgptWeb/transport/index.ts:3`） | **fork-only** | 关闭后 #5/#6 归零；也是 A 节"可选模块"最自然的 seam |
| 10 | SWR 默认 `dedupingInterval` 0 → ~2000ms；admin 轮询周期集中成 fork 常量表由 env 覆盖 | 算法（1 行）+ toggle | `src/libs/swr/index.ts:28`；`useAdminSystem.ts:43`、`audit/shared/useCursorPagination.ts:6`、`networkProxy/hooks.ts:25`、`useIdentityProviders.ts:37,49` | upstream 1 行 + fork | 首屏 −4~6 个重复请求；运维可在小机器上调稀轮询 |

次一级（收益中等，改动同样很小）：
`assertUserActive` 加 5s 进程缓存（见 D2 的约束）；
`platform.getPublicSnapshot` 加 5–10s 进程缓存 + `PLATFORM_SNAPSHOT_POLL_MS`（0=关）；
`ErrorContent`(1.23MB) / `TagCloudCanvas`(1.01MB) 改 `React.lazy`；
`aiAgent/index.ts:2440-2452` 的两次 `getUserSettings()` 合一；
`dist/mobile`(113.8MB) 按部署形态可选（与 E3 镜像议题合并）；
`ProcessingState.tsx:163`/`InitializingState.tsx:63` 的无守卫 `setInterval` 加状态门控；
`useTask.ts:29` 删除与 `:14` 重复的 5s 轮询。

**seam 归属小结**：需要动 upstream 的只有 4 处，且都是"包一层 / 改一个默认值 / 改分包配置"：
`packages/model-bank/src/aiModels/index.ts`（memo）、`apps/server/src/globalConfig/index.ts`（外层 memo）、
`src/libs/swr/index.ts`（1 行）、Vite 的 shiki/i18n 分包。其余全部落在
`src/enterprise/**` 与 `apps/server/src/enterprise/**`。

补充（收益较小但几乎零成本，全 upstream）：
`ProcessingState.tsx:163` / `InitializingState.tsx:63` 的 `useEffect(…,[])` 加状态守卫；
`useTask.ts:29` 删掉与 `:14` 重复的 5s `setInterval`；
`useEditLock.ts:166` 的 viewer peek 对只读场景改用 60s（PageEditor 已经这么做了，`useDocumentLock.ts:93`）。

---

## D. 不要动的东西 + 风险

1. **流式正确性**：`src/app/(backend)/api/agent/stream/route.ts`、`packages/agent-gateway-client` 的
   30s 心跳、`fetchEventSource` 重连逻辑——不要为"省请求"改心跳周期或去掉重连；一次错判会造成对话卡死。
2. **鉴权语义**：`src/libs/oidc-provider/access-control.ts` 的 `assertUserActive` **函数体不能改**
   （ban / `authInvalidatedAt` / 保留会话例外是 Round2/Round3 审计的 CRITICAL 修复面）。
   第 6 号优化只能做"调用侧短 TTL + 失效 epoch"，且 TTL 必须 ≤ 数秒，并在
   ban / revoke / `authInvalidatedAt` 写入时主动 bump epoch，否则等于回退 fail-open。
3. **权限判定**：`withPlatformPermission` 的**判定逻辑与 metadata 注册表**不能动
   （`getPlatformPermissionMetadata` 被安全/策略双注册表校验使用）。第 5 号只做"同一请求内复用已加载的
   permissions 数组"，不得跨请求缓存、不得跨用户共享。
4. **审计完整性**：`auditPermissionDenied`（`platformPermission.ts:131`）与审计证据写入路径不能做
   "批量/异步丢弃"式优化——Round1–4 反复出问题的正是审计取证子系统。
5. **不要把 B7 的缓存当泄漏改**：它们都有界，改动只会引入一致性 bug。
6. **`resolveEgress` 不要以性能为由关闭网络代理模块**——它不是热点（B6）；关闭理由只能是"不需要该功能"。
7. 风险提示：第 8 号（`dedupingInterval` 0→2000）是全局行为变更，可能让某些"连点两次期望两次请求"的
   交互变成一次；需要跑一遍 mutation 后 `mutate()` 的刷新路径回归。

---

## E. 未验证 / 需要真机复验

1. **B9 全节是静态分析，未跑真实对话**：所有"每条消息 X 次 Redis / Y MB clone / Z 次查询"都来自代码路径推导，
   **量级估算（如 1MB stringify、20 provider × 50KB payload）是 [guess]**。
   建议下一轮：发一条真实消息，同时 `docker stats` 采样 + `docker exec ... redis-cli info commandstats`
   前后差值 + `pg_stat_statements` 前后差值，逐条核对 B9 的 12 项。
2. **首屏字节的"压缩后"真实值**：33.8MB 是磁盘未压缩总和；gzip/br 后约 8–10MB [guess]，
   未直接测（浏览器第二次导航走缓存，`transferSize` 只有 74KB，不能用）。
3. **admin 高频轮询的真实开销**：实测中 jobs 3s / audit live 4s 均未触发（需有活跃 job / 手动开 live）。
   其"开启后"的 QPS 与服务端查询数未测。
4. **多用户并发**：本轮只有 1 个管理员标签页。`platform.getCapabilities`/`getPublicSnapshot`
   在 N 个标签页下是 N×(2~3 次 DB 读)/30s，N=50 时的实际 PG 负载未测。
5. **better-auth cookieCache 命中率**：120s TTL 下每请求是否真的 0 次 DB 未用 pg_stat 验证。
6. **admin 概览 10 次 RBAC join 的实际耗时占比**：只测了端到端 7–9ms，未拆分 SQL 时间
   （建议下轮开 `pg_stat_statements` 复测）。
