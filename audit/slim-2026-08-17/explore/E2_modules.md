# E2 — 模块清单与开关接缝（Module inventory & toggle seams）

> 只读探索产物。LOC 统计口径：`git ls-files <dir> | grep '\.tsx\?$' | grep -v '\.test\.' | xargs wc -l`（**不含测试**），
> 与其他报告若有出入多半是对方含测试文件。

---

## A. Summary

1. **现有两套 flag 体系都不做"真禁用"**：upstream `FEATURE_FLAGS`（20 键，`packages/app-config/src/featureFlags/schema.ts:7-46`）服务端只有 3 个消费点，其余纯 UI；fork 的 7 个 `ENABLE_PLATFORM_*`（`packages/const/src/platform/featureFlags.ts:11-21`，**全部 default ON**）只在 procedure 内部抛错/返回空，**没有任何一个能阻止 tRPC 子路由挂载或阻止模块被 import**。
2. **最大的单点罪魁是 `apps/server/src/enterprise/routers/platform.ts:51-81`**：仅仅"被 import"就会执行 `warnIfPlatformMasterKeyMissing` + 3 个 readiness 注册 + **11 个后台 worker 启动**（含 2s/3s 轮询的 agentRollout / auditExport / auditRetention / secretRewrap，和 400ms 健康探测的 mihomo supervisor）。这条 import 链来自 `apps/server/src/routers/lambda/index.ts:21`。
3. `src/instrumentation.ts` 本身写得很干净（**全是 `await import()`**），唯一无条件常驻的是 `GatewayService`（`src/instrumentation.ts:54-65`，非 Vercel + 有 DATABASE_URL 即启动），它背后是 `apps/server/src/services/bot`（17,662 LOC，9 个平台适配器静态 import 于 `apps/server/src/services/bot/platforms/index.ts:3-12`）。
4. **好消息：`@trpc/server@11.18.0` 已导出 `lazy()`**（`dist/unstable-core-do-not-import.d-BdVSvUCr.d.mts:1422`，`lazy(() => import('./x'))`，类型保持）。仓库尚未使用。这让 root router 的"每行一改"式懒加载 + 模块门禁成为最小 upstream diff 的方案。
5. **fork 侧已有三个可直接复用的现成机制**：客户端模块注册表 `src/enterprise/client/registry.ts:130-160`；admin 导航/路由单一真源 `src/enterprise/client/nav/adminNavMeta.ts:80-364`（页面全部 `lazy()`，`adminPageCatalog.tsx:12-96`）；DB+env 双源基础设施配置 `platform_infra_settings`（`apps/server/src/enterprise/services/infraSettings/snapshot.ts`）—— 后者就是"图形化首次配置向导"的现成范式。
6. **建议不要扩展 `FEATURE_FLAGS`**：它经 Redis→Env 复合读取（`apps/server/src/featureFlags/index.ts:48-57`），是运行时可变的；而模块开关必须在 import/mount 时可判定 → 应放 `packages/env/`（或新的 `MODULES` env）+ DB 软开关（仅管 UI/nav）。
7. 六个 fork 模块**完全没有开关**：内容审计、网络代理(mihomo)、平台统计/系统、共享 OAuth、任务模板、ChatGPT Web。
8. 现有唯一两个"开关真的到达 route handler / service"的 upstream 范式是 `ENABLE_OIDC`（`packages/env/src/auth.ts:210,305`）与 `DEVICE_GATEWAY_URL`（`apps/server/src/services/deviceGateway/index.ts:91`）——照抄这个形状即可。

### A-1 Top-10 排序（预估节省 × 门禁难易）

| # | 模块 | 归属 | 现有开关 | 预估节省（eager code / 后台工作 / 外部依赖） | 门禁难度 | 关键接缝 |
|---|---|---|---|---|---|---|
| 1 | **企业后台 worker 群**（agentRollout / auditExport / auditRetention / secretRewrap / connector×2 / instanceRegistry / idpCleanup / brandingCleanup / sharedOAuth / proxySupervisor） | fork | 无（3 个 job 连 flag 都不看） | **CPU**：4 个 2–3s 轮询 + 1 个 400ms 健康探测常驻；内存：11 条 timer 链 | ★易 | `enterprise/routers/platform.ts:51-81`（把 11 行副作用挪进一个 flag 判定的 bootstrap） |
| 2 | **Chat SDK bots / messenger gateway** | upstream | 仅 `MESSAGE_GATEWAY_ENABLED` 且只在 `agent-hono/handlers/gatewayCallback.ts:36` 判 | services/bot 17.6k + messenger 4.6k + gateway 1.6k LOC + 5 个 `chat-adapter-*` 包(≈8.3k) + `discord.js`(serverExternalPackage)；**唯一无条件常驻 job** | ★易 | `src/instrumentation.ts:54-65`；`services/bot/platforms/index.ts:3-12`；lambda `:63,38,24` |
| 3 | **网络代理 mihomo** | fork | 无（仅 `isPersistentEnterpriseWorkerRuntime()` 或 `NETWORK_PROXY_ENGINE_AUTOSTART=1`） | **一整个子进程** + supervisor 400ms 轮询；services 8.1k LOC + 运行时下载二进制 | ★易 | `enterprise/routers/platform.ts:81`；`services/networkProxy/engine/runtime.ts:19-27` |
| 4 | **管理后台 admin console** | fork | `ENABLE_PLATFORM_ADMIN`（default ON） | 客户端：`src/enterprise/client` 64.7k LOC（全 lazy chunk，flag-off 已不下载）；服务端：23 个子路由 + guards 仍全量加载 | ★★中（客户端已完成，服务端未做） | 已有：`src/enterprise/client/routes/index.ts:18`；缺：`routers/lambda/index.ts:88` |
| 5 | **Agent Signal** | upstream | 无 | `apps/server/src/services/agentSignal` **24,673 LOC**（含 Redis store adapters）+ `packages/agent-signal` 1.3k + workflow hono 挂载 | ★★中 | lambda `:30/:97`；`src/server/workflows-hono/index.ts:3,10` |
| 6 | **Upstash workflows** | upstream | 无（只在调用时 throw） | 10 个 route 文件 + 4 个 hono 子 app 常驻挂载；`apps/server/src/workflows` 2.3k | ★易 | `src/app/(backend)/api/workflows/[[...route]]/route.ts:1` + 9 个独立 `serve()` route |
| 7 | **图像/视频生成** | upstream | `ai_image`（UI only） | **`sharp` 静态 import**（原生模块，`services/generation/index.ts:9`、`video.ts:13`）+ 6 个 lambda 路由 + `model-bank` 静态引用 | ★★中 | lambda `:42,51,52,53,55,84`；async `:5,7` |
| 8 | **知识库 / RAG** | upstream | `knowledge_base`（UI only）、`rag_eval`（default false，**服务端零作用**） | 6 个 lambda + 3 个 async 路由；`file-loaders` 解析器已懒加载；**pgvector 不能省**（user memory 也用） | ★★中 | lambda `:41,47,49,58,59,69`；async `:3,4,6` |
| 9 | **异构 agent（claude-code/codex）** | upstream | 无 | `packages/heterogeneous-agents` **17,778 LOC**；但泄漏进 `src/utils/modelLabels.ts:1` 与 store dispatcher | ★★★难（需先解环） | `routers/lambda/device.ts:1`、`services/aiAgent/index.ts:34` |
| 10 | **内容审计 / 审计导出保全** | fork | 内容审计**无 flag**；审计复用 `ENABLE_PLATFORM_ADMIN` | 内容审计 services 5.6k + 客户端 10.3k；审计 services 13.8k + **S3 依赖**；两个 3s worker | ★★中 | `enterprise/routers/admin.ts:177,182`；jobs `auditExport.ts:13`/`auditRetention.ts:13` |

---

## B. Findings（按重要性）

### B1 [CRITICAL] 现有 flag 无一影响"是否加载"
- `apps/server/src/routers/lambda/index.ts:4-85` 静态 import 60+ 个 router，`:87-170` 无条件挂载；`admin: adminRouter`(`:88`)、`platform: platformRouter`(`:136`) 亦然。async/tools/mobile 三个 root 同样无条件（`async/index.ts:9-16`、`tools/index.ts:8-15`、`mobile/index.ts:35-64`）。
- fork flag 的全部作用点：`guards/platformPermission.ts:195`（抛 `ADMIN_FEATURE_DISABLED`）、`guards/adminWebapiGuard.ts:186`、`guards/activeUser.ts:91,115`、`services/platformCapabilities.ts:44-57`、`bootstrap/startupBootstrap.ts:145`、`globalConfig/index.ts:119-120`。**唯一真门禁**是客户端路由树 `src/enterprise/client/routes/index.ts:18-20`。
- upstream flag 的服务端消费点仅 3 处：`routers/lambda/config/index.ts:65-73`（下发给客户端）、`routers/lambda/messenger.ts:64`（`enableWorkspace`）、`services/agentSignal/featureGate.ts:75`。

### B2 [CRITICAL] `platform.ts` 的 import-time 副作用
`apps/server/src/enterprise/routers/platform.ts:51-81` 逐行：
`ensureSkillCatalogReadinessRegistered()`(51) · `warnIfPlatformMasterKeyMissing()`(56) · `ensureConnectorRuntimeAuditWorkerStarted()`(58) · `ensureConnectorRuntimeCapabilityStateBootstrapped()`(61) · `ensureConnectorSecretCleanupWorkerStarted()`(63) · `ensurePlatformAgentRolloutWorkerStarted()`(65) · `ensureIdentityProviderTestAttemptCleanupStarted()`(67) · `ensurePlatformInstanceRegistryCleanupStarted()`(69) · `ensurePlatformSecretRewrapWorkerStarted()`(71) · `ensurePlatformAuditExportWorkerStarted()`(73) · `ensurePlatformAuditRetentionWorkerStarted()`(75) · `ensureBrandingAssetCleanupWorkerStarted()`(77) · `ensureSharedOAuthKeepaliveWorkerStarted()`(79) · `ensureNetworkProxyEngineSupervisorStarted()`(81)。
同类问题：`enterprise/routers/admin.ts:48-50`（3 个 readiness）、`apps/server/src/globalConfig/index.ts:32`（`ensurePlatformAiRuntimeRegistered()`）。

后台 job 周期（来源 `apps/server/src/enterprise/jobs/`，1,215 LOC 含测试）：

| job | 周期 | flag | 启动点 |
|---|---|---|---|
| `agentRollout.ts:12` | 2000ms | `ENABLE_PLATFORM_MANAGED_AGENTS` | platform.ts:65 |
| `auditExport.ts:13` | 3000ms | `ENABLE_PLATFORM_ADMIN` | platform.ts:73 |
| `auditRetention.ts:13` | 3000ms | `ENABLE_PLATFORM_ADMIN` | platform.ts:75 |
| `secretRewrap.ts:12` | 2000ms | **无企业 flag**（仅 key provider=vault） | platform.ts:71 |
| `sharedOAuthKeepalive.ts:14` | 10min | **无 flag** | platform.ts:79 |
| `brandingAssetCleanup.ts:9` | 5min | **无 flag** | platform.ts:77 |
| `identityProviderTestAttemptCleanup.ts:6` | 60s | `ENABLE_DATABASE_OIDC` | platform.ts:67 + cron route |
| `platformInstanceRegistryCleanup.ts:6` | 1h | `ENABLE_DATABASE_OIDC`（**错配**） | platform.ts:69 |
| `networkProxy/engine/supervisor.ts:47` | 400ms 健康探测 | **无 flag** | platform.ts:81 |
| `platformInstance/heartbeatRuntime.ts:91` | 30s | `isAnyEnterpriseFeatureEnabled()`（任一 flag 开即跑） | instrumentation.ts:39-41 |
| `platformObservability/operationalMetricsRuntime.ts:23` | 60s | 需 `ENABLE_TELEMETRY` | instrumentation.ts:84-86 |

`isPersistentEnterpriseWorkerRuntime()`（`jobs/persistentWorkerRuntime.ts:9-17`：production + 非 edge/Vercel/Lambda + 有 DATABASE_URL）是**事实上的总闸**，但它没有自己的 env 开关。

### B3 [HIGH] 客户端已有的模块化骨架（可直接扩展）
- `src/enterprise/client/registry.ts:11-32`（`EnterpriseModuleRegistration`）、`:130-160`（`createEnterpriseModuleRegistry` / `enterpriseModuleRegistry`）—— 已经是"模块注册表"的形状，只是目前只承载 admin 扩展路由，且**快照在模块求值时冻结**（注释 `:151-159`，CS-05）。
- `src/business/client/BusinessDesktopRoutes.tsx:16-17` → `src/enterprise/client/routes/index.ts:16-23` → `createAdminRouteTree`（`routes/admin/createAdminRouteTree.tsx:17-83`）。挂载点：`src/spa/router/desktopRouter.config.tsx:980`、`desktopRouter.config.desktop.tsx:758`、`mobileRouter.config.tsx:514`。
- admin 导航单一真源 `src/enterprise/client/nav/adminNavMeta.ts:80-352`（`ADMIN_NAV_ITEMS`，含权限码）、`:364`（`ADMIN_NAV_FLAT`）。消费者仅 3 处：`features/admin/layout/AdminSideNav.tsx:68`（`filterAdminNavByPermissions`）、`routes/admin/createAdminRouteTree.tsx:18,20`、`features/admin/gates/GroupIndexRedirect.tsx:26`。
- 全部 admin 页面 `lazy()`：`src/enterprise/client/nav/adminPageCatalog.tsx:12-96`（32 个），所以"隐藏 nav 项 + 不注册路由" = 该 chunk 不下载。

### B4 [HIGH] 服务端配置下发链路（模块能力的天然载体）
`apps/server/src/globalConfig/index.ts:118-133` 产出 `GlobalServerConfig.enterprise = { enabled, platformAdmin }` → `src/app/spa/[variants]/[[...path]]/route.ts:108-111` 组装 `SPAServerConfig`（`src/types/spaServerConfig.ts:37-44`）→ `src/server/spaHtml.ts:142` 注入 `window.__SERVER_CONFIG__` → `src/enterprise/client/boot/isPlatformAdminBootEnabled.ts:10-19` / `src/layout/SPAGlobalProvider/index.tsx:36` / `src/store/serverConfig/store.ts:29,36-44`。
另一条：`packages/types/src/platform/capabilities.ts:27-54`（`PlatformCapabilities`，含 `features` 与 `managedResources` 两个布尔袋）+ `:57-76`（`DISABLED_PLATFORM_CAPABILITIES` 安全空快照），由 `enterprise/services/platformCapabilities.ts` 构建、`platform.getCapabilities` 下发。**加一个 `modules: Record<ModuleId, boolean>` 字段即可让全站可读。**

### B5 [MEDIUM] upstream `FEATURE_FLAGS` 端到端
env `FEATURE_FLAGS`（支持 `+x,-y` 语法，`packages/app-config/src/featureFlags/utils/parser.ts`）→ `getServerFeatureFlagsValue()`（`packages/app-config/src/featureFlags/index.ts:19-24`，merge `DEFAULT_FEATURE_FLAGS` `schema.ts:67-105`）→ 服务端 `CompositeRuntimeConfigProvider(Redis, Env)`（`apps/server/src/featureFlags/index.ts:48-57`，Redis 优先、TTL 5s）→ `mapFeatureFlagsEnvToState()`（`schema.ts:107-139`，20 键 → 20 个 `showXxx/enableXxx`）→ `lambda.config.getGlobalConfig`（`routers/lambda/config/index.ts:67`）或 HTML 注入 → `src/store/serverConfig/store.ts:29` → `featureFlagsSelectors`（`src/store/serverConfig/selectors.ts:3`，全仓 54 个消费点，**全是 .tsx**）。
**结论：这是一个"UI 可见性"层，不是"模块装载"层。** 且 Redis 可覆盖 → 天然不适合承载 import 期决策。作为"模块"骨架不合适；应新增独立层。

### B6 [MEDIUM] business stub 的位置
`tsconfig.json:28` 把 `@/business/server/*` 映射到 `packages/business-server/src/*` → `src/business/server/*`（两级 fallback）。客户端 `src/business/client/BusinessDesktopRoutes.tsx`（24 行）是 upstream 文件，fork 只改了 2 行（`:3`、`:17`）去接 enterprise 路由。`packages/business`（285 LOC 非测试）/`packages/business-server`（447）是 cloud 的薄壳。
→ **`src/business/*` 就是 upstream 预留的 edition 接缝，模块注册表放这里 upstream diff 最小。**

### B7 [MEDIUM] webapi / Hono 侧
- `src/app/(backend)/**` 共 **60 个 `route.ts`**，无统一 wrapper（Next 每文件独立 entry）。但可门禁的聚合点只有 4 个 catch-all：`api/agent/[[...route]]/route.ts:1`→`src/server/agent-hono/index.ts:30-89`（14 个 handler 静态 import）；`api/v1/[[...route]]/route.ts:1`→`@lobechat/openapi`（14.9k LOC）；`api/workflows/[[...route]]/route.ts:1`→`src/server/workflows-hono/index.ts:3-13`；`trpc/{lambda,async,tools,mobile}/[trpc]/route.ts`。
- fork 只有 1 个 webapi route：`webapi/admin/network-proxy/artifact/route.ts`，已在 `enterprise/security/policy/adminWebapiRouteRegistry.ts:18-27` 登记。
- 其余按模块归属：market×5、oidc×7、workflows×10、memory webhooks×4、casdoor/logto webhook×2、composio×1、video webhook×1、dev×3。

### B8 [LOW] 其他量化事实
- `packages/builtin-tools/src/index.ts:1-34` 静态 import **28 个 `builtin-tool-*` 包**（合计 ≈60k LOC），`defaultToolIds`(`:42-55`) 只用其中 12 个。
- `apps/server/src/services/search/impls/index.ts:1-11` 静态 import 11 个搜索 provider。
- `sharp` 静态 import 于 4 处（generation/video/ingestAttachment/branding assetStorage）。
- `locales/` 磁盘 25MB / 18 语言；`admin.json` 单语言 244KB（×18 ≈ 4.4MB），`models.json` 268KB。
- `serverExternalPackages`：`src/libs/next/config/define-config.ts:356-365`（pdfkit / @napi-rs/canvas / @lobehub/editor / **discord.js** / ffmpeg-static / pdfjs-dist / ajv / oidc-provider）。
- fork 规模（非测试）：`apps/server/src/enterprise` 99,482 LOC/512 文件；`src/enterprise` 64,717/473；`src/features/AdminToolScope` 181。

---

## C. 推荐接缝（最少改动 · 兼容 upstream merge）

> 记号：**[U]** = upstream 文件（改动要极小、可 revert）；**[F]** = fork-only 文件（可随意）。

### C1 单一服务端模块注册表 —— 落点 `packages/env/src/modules.ts` **[F 新文件]** + `src/business/server/modules.ts` **[F 新文件]**
接口伪码（不写实现）：
```
type ModuleId = 'knowledgeBase' | 'imageGen' | 'stt' | 'webSearch' | 'market' | 'mcp'
              | 'bots' | 'agentSignal' | 'memory' | 'notebook' | 'sandbox' | 'device'
              | 'heteroAgents' | 'workflows' | 'oidc' | 'telemetry'
              | 'platformAdmin' | 'managedAi' | 'managedSkills' | 'managedConnectors'
              | 'managedAgents' | 'settingsPolicy' | 'branding' | 'databaseIdp'
              | 'audit' | 'moderation' | 'networkProxy' | 'platformStats'
              | 'sharedOAuth' | 'taskTemplates' | 'chatgptWeb';
isModuleEnabled(id): boolean          // 纯 env，import 期可判定，无 IO
getModuleSnapshot(): Record<ModuleId, boolean>
```
env 形态照抄 `FEATURE_FLAGS` 的 `+a,-b` 语法但**独立键名** `LOBE_MODULES`（避免与 Redis 可变的 FEATURE_FLAGS 混淆，见 B5）。

### C2 五个装配点（本报告要求的精确 file:line）

| # | 装配点 | 文件:行 | 归属 | 改动形态 |
|---|---|---|---|---|
| 1 | **tRPC root router** | `apps/server/src/routers/lambda/index.ts:87-170`（另 `async/index.ts:9-16`、`tools/index.ts:8-15`、`mobile/index.ts:35-64`） | **[U]** | 把 `knowledgeBase: knowledgeBaseRouter` 改成 `knowledgeBase: moduleRouter('knowledgeBase', () => import('./knowledgeBase'))`，内部用 `@trpc/server` 的 `lazy()`（v11.18.0 已支持，`lazy` 签名见 `unstable-core-do-not-import.d-BdVSvUCr.d.mts:1422`）。**每模块一行，纯替换，rebase 冲突面最小**；关闭时返回一个抛 `MODULE_DISABLED` 的 stub router 以保住类型。 |
| 2 | **webapi / Hono wrapper** | 无统一 wrapper；实际聚合点 4 个：`src/app/(backend)/api/agent/[[...route]]/route.ts:1`、`api/v1/[[...route]]/route.ts:1`、`api/workflows/[[...route]]/route.ts:1`、`src/server/agent-hono/index.ts:30` | **[U]** | 在 `agent-hono/index.ts:30` 之后加**一条** `app.use('*', moduleGate)` 中间件（路径前缀→ModuleId 映射表放 fork 文件）；workflows/v1 两个 catch-all 各加 3 行早退。散装 route.ts（market×5、oidc×7、memory×4）暂不动，靠 C3 的 service 层空实现兜底。 |
| 3 | **instrumentation** | `src/instrumentation.ts:54-65`（GatewayService）；`:39-41`（heartbeat）；`:84-86`（metrics） | **[U]** | 只在 `:56` 的条件里 `&& isModuleEnabled('bots')`。其余已是 `await import()`，天然安全。 |
| 4 | **SPA router config** | `src/spa/router/desktopRouter.config.tsx:980` / `desktopRouter.config.desktop.tsx:758` / `mobileRouter.config.tsx:514`（`getBusinessDesktopRoutesWithoutMainLayout()`） | **[U] 但已是 fork 唯一接口** | 不改这三行；改 **[F]** `src/business/client/BusinessDesktopRoutes.tsx:16-17` → `src/enterprise/client/routes/index.ts:16-23`，在返回路由树前按模块过滤。用户端功能路由（`/memory`、`/image`、`/video`、`/eval`、`/community` 等，`desktopRouter.config.tsx:159-698`）若也要摘除，需新增**一个** `filterRoutesByModule(routes)` 包裹 `export const desktopRoutes`（`:705`）—— 一处调用，不逐条 if。 |
| 5 | **admin nav builder** | `src/enterprise/client/nav/adminNavMeta.ts:80-352`（`ADMIN_NAV_ITEMS`）+ `:364`（`ADMIN_NAV_FLAT`）；消费者 `features/admin/layout/AdminSideNav.tsx:68`、`routes/admin/createAdminRouteTree.tsx:18,20`、`gates/GroupIndexRedirect.tsx:26` | **[F]** | 给 `AdminNavItem` 加可选 `moduleId`（约 12 个叶子需标注），在 `ADMIN_NAV_FLAT` 生成处（`:364`）或 `filterAdminNavByPermissions` 旁再串一层 `filterAdminNavByModules`。**两个消费者同时受益，导航与路由不会漂移。** |

### C3 fork 侧必须额外处理的两个"副作用点" **[F]**
- `apps/server/src/enterprise/routers/platform.ts:51-81`：把 14 行副作用整体搬进 `enterprise/bootstrap/workersBootstrap.ts`（新文件），由 `src/instrumentation.ts` **[U] 加 5 行** `await import()` 调用，每个 `ensure*Started()` 前加 `isModuleEnabled(...)`。这一步同时修好 3 个"无 flag 就跑"的 job 与 `ENABLE_DATABASE_OIDC` 错配（`platformInstanceRegistryCleanup.ts:80,110`）。
- `apps/server/src/enterprise/routers/admin.ts:48-50`、`apps/server/src/globalConfig/index.ts:32` 同理下沉。

### C4 图形化首次配置向导的现成范式 **[F]**
`platform_infra_settings` 单例行表（`packages/database/src/schemas/platform/infraSettings.ts:17,32-33`，`id IN ('object_storage','mail')` + `revision`）+ `services/infraSettings/snapshot.ts`（DB 优先、env 兜底、fingerprint 缓存、Redis 失效）+ 管理端卡片 `src/enterprise/client/features/admin/systemGeneral/InfraSettingsCard.tsx`。
→ 新增 `id='modules'` 行即可承载**软开关**（UI/nav 可见性、admin 页面显隐），env 承载**硬开关**（import/mount/job）。两层必须明确分工，见 D3。

### C5 能力下发 **[F]**
`packages/types/src/platform/capabilities.ts:27-54` 加 `modules: Record<ModuleId, boolean>`；`packages/types` 是 fork 与 upstream 共用但该文件在 `platform/` 子目录（fork-only）。同时 `apps/server/src/globalConfig/index.ts:133` 的 `enterprise: {...}` 旁加一个 `modules` 字段 **[U 加 1 行]**，让 `__SERVER_CONFIG__` 同步可读（`src/types/spaServerConfig.ts:37-44` 不需改，随 `GlobalServerConfig` 走）。

---

## D. 不要动 / 风险清单

1. **`packages/database/migrations/**` 一律不动。** `vector` 与 `pg_search` 在 `0000_squash_baseline.sql:3,5` 无条件创建；`pg_search` 的 bm25 索引覆盖 `agents/topics/messages/chat_groups`（核心，永不可摘）。**"关掉知识库就能换掉 ParadeDB"是错的**，且 `vector` 被 user memory（12 个 vector 列）同样依赖。DB 层不是本轮的节省来源。
2. **`enterprise/security/policy/adminMutationRegistry/`（114 条）与 `adminWebapiRouteRegistry.ts`（1 条）有"每个 admin mutation 必须恰好一条登记"的守护测试**（`adminMutationRegistry.test.ts`、`security.ts` 侧）。把 admin 子路由换成 disabled stub 会让注册表完整性测试失配 —— stub 必须保留 procedure 名字，或测试改为按"已挂载模块"过滤。
3. **`services/settings/runtimeSettingsAdapter.ts` 与 `services/branding/runtimeBranding.ts` 已渗入核心路径**（前者被 `routers/lambda/user.ts:50-53`、`agentGroup.ts:20`、`userMemories.ts:46`、`services/agent|systemAgent|taskReview|aiAgent` 等 7+ 处 import；后者被 `src/app/manifest.ts:9`、`metadata.ts:7`、`services/email/index.ts:8`、`MessengerRouter.ts:17` import）。**settingsPolicy / branding 不能用"停止挂载"的方式关闭**，只能做 null-adapter，否则核心链路崩。同理 `services/chatgptWeb/transport` 被 `modules/ModelRuntime/index.ts:32` 静态 import。
4. `packages/heterogeneous-agents`（17.8k LOC）泄漏到 `src/utils/modelLabels.ts:1` 与 `src/store/chat/.../agentDispatcher.ts:2` —— **先解环再谈门禁**，否则改动会扩散到共享 utils（upstream 冲突大户）。
5. `src/spa/router/desktopRouter.config.tsx` 与 `.desktop.tsx` 必须同步（`desktopRouter.sync.test.tsx` 守护）。任何路由过滤逻辑要放在两者共用的函数里，不能只改一个。
6. `enterpriseModuleRegistry` 的路由快照在模块求值时冻结（`src/enterprise/client/registry.ts:151-159`），`register()` 之后不刷新 —— 模块开关必须在 `__SERVER_CONFIG__` 注入后、SPA entry 求值前可读（现状已满足，因为是同步 HTML 注入）。
7. `ENABLE_ENTERPRISE_ADMIN` 是 `ENABLE_PLATFORM_ADMIN` 的别名（`packages/const/src/platform/featureFlags.ts:111-117`），新开关体系不要再制造第二个别名。
8. 所有企业 flag **default ON**（`featureFlags.ts:45-54`）。若新模块开关沿用 default-ON 语义，现网升级不会变行为（好）；但"瘦身"要生效必须让运维显式关 —— 需要在 `docker-compose/enhanced/docker-compose.yml:39-46` 旁补一组新变量并写进 README。

---

## E. 需要真机验证的项（本轮静态无法确认）

1. **11 个 worker 的实际 CPU 占比**：idle 4-5% 中 2s/3s 轮询（agentRollout / auditExport / auditRetention / secretRewrap）与 mihomo supervisor 400ms 探测各占多少 —— 需在容器里对 `next-server` 做一次 30s CPU profile / 或逐个 `ENABLE_*=0` 对照。[guess] 我判断这 4 个 2–3s 轮询是空载 CPU 的主要来源，但未测。
2. **`lazy()` 在 Next 16 standalone 构建下是否真的产生独立 server chunk**（而非被 turbopack 内联回主 bundle）→ 直接决定方案 1 能否省 RSS。需要一次 `output: 'standalone'` 构建 + `.next/standalone` 体积/chunk 对比。
3. **700MB RSS 的构成**：`model-bank`(50k LOC)、`@lobechat/openapi`(14.9k)、28 个 builtin-tool、9 个 bot 适配器各自占多少 heap —— 需 `--heapsnapshot-signal` 或 `NODE_OPTIONS=--max-old-space-size` 对照实验。本报告的 LOC 只能作为相对排序，**不能当作 MB**。
4. **mihomo 子进程的常驻内存与 CPU**（pid1 的 child），以及关闭 `NETWORK_PROXY_ENGINE_AUTOSTART` 后 egress hook（`services/networkProxy/egress/hook.ts`，被 `routers/tools/market.ts:30` 使用）是否优雅回退直连。
5. `packages/locales` 18 语言是否全部进客户端 bundle（HTML 模板里看到 `i18n-en-US` / `i18n-default` / `i18n-ar` 三个 modulepreload，其余可能按需）—— 若全量进包，砍语言是低风险的体积收益。
6. `GatewayService.ensureRunning()` 在没有任何 bot 配置时的实际开销（是否只是一次 DB 查询后 idle）。
7. 关闭 `ENABLE_PLATFORM_ADMIN` 后 admin chunk 是否真的不下载（`adminPageCatalog.tsx` 全 lazy，理论成立），以及 `/admin` 深链是否稳定 404 而非白屏。
