# E4 — 管理端降级与首启配置向导的接缝（静态代码勘探）

Repo: /Users/konata/code/AIHub @ main（只读勘探，未修改任何仓库文件）

---

## A. 摘要（给指挥官决策）

1. **能力下发不需要新造通道**：boot 期同步的 `window.__SERVER_CONFIG__.config.enterprise`（类型 `packages/types/src/serverConfig.ts:59-71`，生产端 `apps/server/src/globalConfig/index.ts:119-133`）决定 `/admin` 整棵路由树是否注册；运行期的 `platform.getCapabilities`（`packages/types/src/platform/capabilities.ts:27-54`）决定页面内降级。**把 `modules` 同时挂到这两处即可**。
2. **关键发现：模块开关可以做成"热生效"，不必重启**。`getServerGlobalConfig()` 本来就是 async 且已经在读 DB（`apps/server/src/globalConfig/index.ts:141` `enableUploadFileToServer: await resolveEnableUploadFileToServer()`），所以 DB 里的模块集合**每次 HTML 请求都能进 `__SERVER_CONFIG__`**（用户刷新页面即生效）；而 tRPC 的模块闸门是**每请求中间件**（`apps/server/src/enterprise/routers/admin/system.ts:70-79` 就是现成范式），router 形状永不变化。**真正需要重启的只有三类**：`src/instrumentation.ts` 启动的后台设施、Better Auth 进程启动时固定的插件集、mihomo 子进程。
3. **服务端只需改一处就能让全部 admin procedure 认识"模块关停"**：`apps/server/src/enterprise/guards/platformPermission.ts:181-227` 是所有 214 个带权限的 admin procedure 的必经中间件，`:195-200` 已经在 `ENABLE_PLATFORM_ADMIN` 关闭时抛 `ADMIN_FEATURE_DISABLED`，且中间件已经解构了 tRPC `path`（`:185`、`:213` 用于审计）。按 path 前缀查一张模块映射表再抛一次即可。**零散落编辑、全部 fork-only**。
4. **绝对不要按模块条件挂载 router**。`security/policy/adminProcedureAuthorization/reconcile.ts:57-65` 用**对象身份**把 215 条注册表项与 `lambdaRouter._def.procedures` 对账；条件不挂载会让 **215 条全部报 `invalid lambda mount`**（测试已显式证明这一行为：`adminProcedureAuthorizationRegistry.test.ts:134-156`）。而且 `AdminRouter` 类型会随 env 漂移。**always mount + runtime guard**。
5. **"路由不存在"在今天是最差的降级形态**：tRPC `NOT_FOUND` 不带 `errorData` → `mapEnterpriseError` 返回 `null` → 落到 `users.errors.generic`；更糟的是 `src/enterprise/client/services/adminAuth.ts:45-55` 把 `NOT_FOUND` 判为**可重试**，于是 `AdminRootGate` 会渲染一个**永远点不通的重试按钮**。这是"必须用 FORBIDDEN 语义码而不是不挂载"的硬证据。
6. **前端降级 UI 与错误码全部现成**，只差一个 `MODULE_DISABLED` 分支：`AdminFeatureOffSurface`（`pages/AdminStateSurfaces.tsx:83-98`，文案键 `feature.off.*` 已存在）、`AdminPageTemplate.banner` 槽、`mapEnterpriseError.ts:26,33` 已收录两个 `*_FEATURE_DISABLED` 码并映射 action `none`、locale 已有 `enterprise.error.*` 文案。
7. **nav 与路由共用同一份目录**（`src/enterprise/client/nav/adminNavMeta.ts` 的 `ADMIN_NAV_ITEMS`），给 item 加一个 `moduleId?`，改 `filterAdminNavByPermissions` 一个函数就同时管住"菜单隐藏"和"直链降级"。
8. **存储模板选 `platform_auth_settings` / `platform_sidebar_layout`（`id='global'` 单例 + CAS revision）**，读取层照抄 `infraSettings/snapshot.ts` 的 `DomainConfigCache`(TTL 30s) + `publishInfraInvalidation` Redis scope 失效 —— **跨实例热刷新，无重启**。
9. **向导放 `/admin/system/modules`**（`system` 分组下新 nav item），首启用"标记行缺失 → 概览页引导卡 + `?wizard=1` 进入步骤态"实现，**零新路由、零 upstream 路由配置改动**。不要复用 `src/routes/onboarding`（那是 per-user 的 `users.is_onboarded`，且挂在两个必须同步的 upstream router config 上）。
10. **必须改的 upstream 文件只有 2 个**：`packages/types/src/serverConfig.ts`（加 1 个可选字段）、`apps/server/src/globalConfig/index.ts:133`（同一行块补 1 个字段）。其余全部 fork-only。
11. **最大风险**：`tests/setup.ts:74-86` 把现有 9 个 `ENABLE_*` 全部 `??= '0'`，测试基线是"全关"；新增模块开关若沿用"默认 ON"，测试基线与生产基线不一致，容易掩盖回归。**必须在设计时就决定测试基线并写进 setup**。

---

## B. 发现（按重要性）

### B1. 能力下发的三条现有通道

| 通道 | 生产者 | 消费者 | 时机 | 现有内容 |
|---|---|---|---|---|
| `window.__SERVER_CONFIG__.config.enterprise` | `apps/server/src/globalConfig/index.ts:119-133` → `src/app/spa/[variants]/[[...path]]/route.ts:105-117` → `src/server/spaHtml.ts:141-142`（正则替换 `index.html:128` 里的占位符） | `src/enterprise/client/boot/isPlatformAdminBootEnabled.ts:10-19`（同步、无 React）；`src/layout/SPAGlobalProvider/index.tsx:36,45-48` 灌进 `ServerConfigStoreProvider` | HTML 注入，**SPA entry 求值前** | `{ enabled: boolean; platformAdmin?: boolean }` |
| `platform.getCapabilities`（authed） | `apps/server/src/enterprise/routers/platform.ts:144-171`；builder `services/platformCapabilities.ts:39-70` | `src/enterprise/client/providers/useEnterprisePlatformData.ts:113-121`，**refreshInterval 60_000ms** | 登录后轮询 | `features:{databaseOidc,platformAdmin,runtimeBranding}` + `managedResources` + revisions；**无 `.output()` schema** |
| `platform.getPublicSnapshot`（public） | `platform.ts:173-177` | 同上 `:122-131`，**refreshInterval 30_000ms** | 匿名也轮询 | branding / 登录方式 |

- `SPAServerConfig` 全量键在 `src/types/spaServerConfig.ts:37-44`：`analyticsConfig / clientEnv / config / featureFlags / isMobile / platformPublicSnapshot`。
- 上游 featureFlags 是另一条并行通道（`packages/app-config/src/featureFlags/schema.ts:7-45`），前端 **54 处**消费点。它有 userId 灰度数组语义，且是上游高频变更文件 —— **模块开关不要与之合并**。
- **企业 flag 只有 8 个且全部默认 ON**（`packages/const/src/platform/featureFlags.ts:44-54`；解析 `apps/server/src/enterprise/featureFlags/parseEnterpriseFeatureFlags.ts:24-37`，只有显式 `0/false/no/off` 才关）。它们**不覆盖 audit / moderation / networkProxy / stats / taskTemplates / users 这些真正吃资源的模块** —— 这是本批次要补的缺口。
- vite dev 坑复核：`src/server/spaHtml.ts:10-11` 的占位符只在 Next 侧被替换；`bun run dev:spa` 直连时 `__SERVER_CONFIG__` 保持 `undefined` → `isPlatformAdminBootEnabled()` 恒 false → `/admin` 整树不注册。**任何 boot 期模块开关都继承这个坑**。

### B2. `/admin` 路由树与 nav 的单一目录

- `src/enterprise/client/nav/adminNavMeta.ts:80-350` 的 `ADMIN_NAV_ITEMS` 是**菜单可见性与路由守卫的唯一真相**（文件头 `:47-49` 自述）。扁平化后 `ADMIN_NAV_FLAT`（`:143`）被三处消费：
  - `routes/admin/createAdminRouteTree.tsx:21-40` 生成叶子路由（element 从 `nav/adminPageCatalog.tsx` 取，**全部 `lazy()`**）；
  - `nav/adminNavMeta.ts:427-455` `filterAdminNavByPermissions` → 唯一调用点 `features/admin/layout/AdminSideNav.tsx:67-70`；
  - `:461` `canAccessAdminPath` → `features/admin/gates/AdminPermissionOutlet.tsx:50-56` 决定 403。
- 整树注册与否由 `src/enterprise/client/routes/index.ts:16-23` 一句 `if (!isPlatformAdminBootEnabled()) return []` 决定；`:31-32` 在**模块求值时**快照，改变需整页刷新（不是服务端重启）。回归测试 `routes/flagOff.regression.test.ts:40-56` 断言 flag off 时 `/admin`、`/admin/users` 都 `matchRoutes === null`。**这是模块级"隐藏"最干净的先例**。
- 扩展点已存在：`src/enterprise/client/registry.ts:11-31` 的 `enterpriseModuleRegistry` 支持注册 `/admin/**` 子路由并强制 `handle.admin.requiredPermissions`。

### B3. 依赖可选模块的管理端页面清单

权限来自 `packages/const/src/platform/permissions.ts:7-112`（**70 个码**）；后端 sub-router 来自 `apps/server/src/enterprise/routers/admin.ts:172-195`（**23 个**）；LOC = 前端源码行数（不含 test）。

| 模块 | 路由 | 权限码 | sub-router | 外部依赖 | 前端 LOC |
|---|---|---|---|---|---|
| 审计（日志/实时/会话/导出/保全/留存） | `/admin/audit/*`（9 个叶子） | `AUDIT_READ` / `AUDIT_CONVERSATION_READ` / `AUDIT_EXPORT` / `AUDIT_LEGAL_HOLD_MANAGE` / `AUDIT_RETENTION_OPERATE` | `admin.audit` | **S3**（`services/audit/exportStorage.ts`）+ job `auditExport.ts` / `auditRetention.ts`（二者已被 `ENABLE_PLATFORM_ADMIN` 门控，`:21,44,59`） | 6653 |
| 内容审计 | `/admin/audit/content-moderation` | `MODERATION_READ` | `admin.contentModeration` | **worker_threads**（`services/contentModeration/regexWorker.ts`）+ LLM 调用 | 6273 |
| 网络代理 | `/admin/system/general?tab=network-proxy` | `NETWORK_PROXY_READ` | `admin.networkProxy` | **mihomo 子进程**（由 `platform_network_proxy_settings.engine_generation` 广播驱动） | 4224 |
| 安全与认证 / 登录方式 | `/admin/identity-providers` | `IDENTITY_READ` | `admin.identityProviders` + `admin.authSettings` | OIDC LKG 卷 + 重启控制器 | 4507 |
| 平台助理 | `/admin/agents` | `AGENT_READ` | `admin.agents` | job `agentRollout.ts:22,41,51` | 5969 |
| 技能 | `/admin/ai/skills`、`/admin/skills` | `SKILL_READ` | `admin.skills` | — | 3732 |
| 连接器 | `/admin/ai/connectors`、`/admin/connectors` | `CONNECTOR_READ` | `admin.connectors` | 共享 OAuth + `sharedOAuthKeepalive` job | 2944 |
| 用户 | `/admin/users` | `USER_READ` | `admin.users` | —（核心，不可关） | 4167 |
| 统计 | `/admin/stats` | `STATS_READ` | `admin.stats` | 重查询 | 512 |
| 品牌 | `/admin/branding` | `BRANDING_READ` | `admin.branding` | **S3**（`services/branding/assetStorage.ts`）+ `brandingAssetCleanup` job | 1265 |
| 任务模板 | `/admin/ai/task-templates` | `AGENT_READ`（复用） | `admin.taskTemplates` | — | 2065 |
| 受管资源/设置策略/统一管理 | `/admin/unified`、`/admin/settings`、`/admin/managed-resources` | `SETTINGS_READ` / `POLICY_READ` | `admin.settings` / `admin.managedResources` | — | 2933 |
| AI 服务商/模型 | `/admin/ai/providers` | `AI_PROVIDER_READ` | `admin.aiProviders` / `aiModels` / `aiProviderOAuth` | — | 3925 |
| 系统状态 | `/admin/system/status` | `SYSTEM_READ` | `admin.system` | Redis/S3/mail 探针 | 1853 |
| 基础设施 | `/admin/system/general?tab=infrastructure` | `SYSTEM_READ` | `admin.system` | `platform_infra_settings` | 2621 |

`/admin` 前端合计 **417 个源文件 / 59 220 行 / 4.6MB 源码**。**注意：`adminPageCatalog.tsx` 里全是 `lazy()`，关闭模块省的是"打开该页才下载的 chunk"，不是首屏体积** —— 管理端裁剪对 RSS/CPU 的收益主要来自后端 job / 轮询 / worker，不是前端 bundle。

### B4. 今天"后端缺失"会怎样降级（关键反面证据）

tRPC v11 对不存在的 path 抛 `{code:'NOT_FOUND', message:'No "query"-procedure on path "…"'}` → HTTP 404。链路：

1. `packages/trpc/src/lambda/init.ts:19-28` 的 errorFormatter **只在 `error.cause` 带 `data` 时**才附 `errorData`；missing-path 无 cause → **无 `errorData`**。
2. `packages/trpc/src/client/lambda.ts:95-97` 的 `errorHandlingLink` 只特判 401，其余 `console.error` 后原样抛出 —— **404 没有任何 toast 通道**。
3. `src/enterprise/client/errors/mapEnterpriseError.ts:60-97` 三种 body 提取全落空 → 返回 `null` → `features/admin/users/utils.ts:47` 落到 `users.errors.generic`。
4. **最坏的一条**：`src/enterprise/client/services/adminAuth.ts:45-55` 的 `isAdminAccessErrorRetryable` 只把 `UNAUTHORIZED`/`FORBIDDEN` 判为不可重试 → `NOT_FOUND` 被判**可重试** → `providers/AdminAccessProvider.tsx:110-119` 置 `status:'error'` → `gates/AdminRootGate.tsx:91-98` 渲染 `AdminAccessErrorSurface` **带一个永远点不通的重试按钮**。

读路径上各页自行渲染 `xxx.loadFailed`（`contentModeration/settings/SettingsTab.tsx:66`、`contentModeration/overview/OverviewTab.tsx:112`、`settings/SettingsPolicyPage.tsx:136`）。**结论：今天会显示"加载失败"而不是"模块未启用"，语义错误且诱导运维去查故障。**

### B5. 现成的"模块未启用"UI 原语

| 原语 | 位置 | 可复用性 |
|---|---|---|
| `AdminFeatureOffSurface` | `features/admin/pages/AdminStateSurfaces.tsx:83-98`，键 `feature.off.title/desc`（`packages/locales/src/default/admin.ts:216-217`） | **直接改造成带 `moduleId` 的 `AdminModuleDisabledSurface`**，加"如何启用"副行 |
| `AdminPageForbiddenSurface` / `AdminNotFoundSurface` | 同文件 `:121-152` | 模式模板 |
| `AdminPageTemplate` 的 `banner` / `notice` 槽 | `features/admin/primitives/AdminPageTemplate.tsx:68,92` | 页面级"该模块只读/已停用"横幅 |
| `AdminPermissionOutlet` | `features/admin/gates/AdminPermissionOutlet.tsx:38-79` | **插入模块判定的最佳单点** |
| 按权限裁 Tab 的先例 | `features/admin/systemGeneral/SystemGeneralPage.tsx:36-107`（两 tab 各自 `canRead`，且 `:43-48` 明确"绝不把管理员留在打不开的 tab 上"） | 模块级 tab 裁剪照抄 |
| "未配置 → 引导"整页替换 | `features/admin/identityProviders/IdentityProviderPage.tsx:57,194`（`IdentityProviderSetupGuidance`） | 向导的轻量替代形态 |
| 错误码 → toast | `errors/mapEnterpriseError.ts:26,33` + `primitives/runAdminMutation.ts:47-56` | 已覆盖，加码即可 |

**不需要新组件，只需要一个新判定源 + 一个新错误码分支。**

### B6. 服务端注册与守卫

- **唯一必经中间件**：`apps/server/src/enterprise/guards/platformPermission.ts:181-227`。`:195-200` 已在 flag off 时抛 `ADMIN_FEATURE_DISABLED`(FORBIDDEN)；`:225` 通过非枚举 Symbol 挂上权限元数据供注册表读取。**中间件已拿到 tRPC `path`**（`:185` 解构、`:213` 用于审计）→ 按 path 前缀判模块零额外管道。唯一例外是 `admin.auth.getMyAccess`（无权限门，`admin.ts:57-74`）。
- **三张注册表**（全在 `apps/server/src/enterprise/security/policy/`，**没有** `enterprise/policy/` 目录）：
  - `adminProcedureAuthorization/registry.ts:16-21` → **215 条**（测试钉死 215 / query 101 / mutation 114，`adminProcedureAuthorizationRegistry.test.ts:92-99`）；
  - `adminMutationRegistry/registry.ts:11-16` → **114 条**（纯静态 AST 对账，察觉不到挂载变化）；
  - `adminWebapiRouteRegistry.ts:18-27` → **1 条**（扫盘对账，同样察觉不到挂载）。
- **条件挂载会炸得最响**：`adminProcedureAuthorization/reconcile.ts:57-65` 按**对象身份**把 `adminRouter._def.procedures` 的每条与 `lambdaRouter._def.procedures` 匹配，不匹配就 `invalid lambda mount: <path>`；`:95-98` 反向查 `unexpected lambda admin mount`；`:113` 汇总抛出。测试 `:134-156` 已显式证明"删掉一个挂载 → 抛 `invalid lambda mount: admin.audit.get`"。若整个 `admin` 键条件化，**215 条全炸**。
- **测试基线是"全关"**：`tests/setup.ts:74-86` 对 9 个 `ENABLE_*` 做 `process.env[key] ??= '0'`。注册表测试在这种基线下仍然通过，正是因为挂载是静态、与 flag 无关的。
- **注册表应如何对待"挂载但禁用"**：结构断言保持不变（永远断言 mounted），**新增一个可选 `module?: ModuleId` 字段**（默认 `core`），再加一条"同一 sub-router 下 module 一致"的轻断言。这样注册表条数**不随部署配置变化**，CI 只跑一种形态。
- **导入期副作用**：`apps/server/src/enterprise/routers/admin.ts:48-50` 在模块求值时执行 `ensureAiCatalogReadinessRegistered()` / `ensureConnectorCatalogReadinessRegistered()` / `ensureSkillCatalogReadinessRegistered()`。运行期禁用模块**不会**跳过它们；要真省资源需让这三个 `ensure*` 自读模块开关早退（fork-only，3 行）。
- 现有 flag 的三种执行形态（都在已挂载的 procedure 内部）：① 中间件硬 403；② resolver 内抛 `PLATFORM_FEATURE_DISABLED`（branding `:41-43`、settings `:43`、skillsSupport `:25-27`、agentsSupport `:24-26`、identityProviders `:59`、user/connectors `:98`）；③ 静默返回空/中性值（`platform.ts:99,119,192-194`）。**模块闸门应统一用形态 ①/②，不要用 ③**（③ 会让"关模块"看起来像"没数据"）。

### B7. 首启 / 存储 / 重启机制

- **没有任何首启标记表**：schema 里不存在 `platform_settings` / `platform_setup`；`users.is_onboarded`（`packages/database/src/schemas/user.ts:24`）是 per-user，且社区版在 `apps/server/src/routers/lambda/user.ts:188-189` 硬编码 `?? true`。**需要新增一个全局标记**。
- **唯一的服务端首启钩子**是 `apps/server/src/enterprise/bootstrap/startupBootstrap.ts:138-166`（`BOOTSTRAP_SUPER_ADMIN_*`），它是 **env 驱动 + 幂等**，不是标记驱动；`:82` 每次启动都跑 `ensurePlatformRbacSeeded(db)`。
- **`src/instrumentation.ts` register() 步骤**：① `bootstrapPlatformAdminRuntime()`（:15-23，受 `ENABLE_PLATFORM_ADMIN` / `DATABASE_URL` / build phase 三重门）；② `bootstrapIdentityProviderRuntime()`（:28-36，内部 `ENABLE_DATABASE_OIDC`）；③ `ensurePlatformInstanceHeartbeatStarted()`（:38-46）；④ GatewayService（:53-65）；⑤/⑥/⑦ 遥测 + OTel + 运营指标（:73-86）。三个企业步骤各自 try/catch 非阻塞（:11-14 注明原因）。**这些是真正的 boot-time-only 项**。
- **env-vs-DB 的黄金模板 = 基础设施卡**：
  - 表 `packages/database/src/schemas/platform/infraSettings.ts:16-35`（text PK + CHECK、jsonb config、CAS `revision`、`updatedBy`）；
  - 规则 `docs/enterprise/infra-settings.md:5-13`：**`effective(card) = db[card].enabled ? db[card] : env[card]`，每张卡 all-or-nothing，绝不逐字段合并**（实现 `services/infraSettings/snapshot.ts:192-229`，把 DB config 投影成 env 形状的 bag 后喂给同一个 resolver —— 一套解析器两个来源）；
  - 失败阶梯 `snapshot.ts:176-190,261-292`：DB/解密失败 → 进程内 LKG → env 默认；
  - 缓存 `DomainConfigCache` TTL **30_000ms**（`packages/const/src/platform/infraSettings.ts:29`），失效靠 `publishInfraInvalidation`（`snapshot.ts:302-311`）发 Redis scope version → **跨实例热刷新，无重启**；
  - 写入 `routers/admin/system.ts:355-435`：`SYSTEM_OPERATE` + 危险动作 reauth + 单事务 CAS + 审计 + commit 后广播失效。
- **可作单例模板的表**：`platform_auth_settings`（`authSettings.ts:14`，`id='global'`，行缺失时模型套用内置默认 → 新装即"开放"）、`platform_sidebar_layout`（`sidebarLayout.ts:16`，`id='global'` + CAS）。`platform_task_templates`（`taskTemplates.ts:34-38`）是"空表有语义、回退内置默认"的最佳先例。
- **"无重启的期望态广播"另有先例**：`platform_network_proxy_settings.engine_generation`（`networkProxy.ts:21-24`）—— 每个实例的 supervisor 观察到更大的 generation 就重启引擎，进程不重启。
- **重启机制**：`services/identityProvider/restartController.ts:19-35` 判定能力（test/edge/serverless 一律不支持；仅 `PLATFORM_OIDC_RESTART_MODE === 'supervisor'` 才支持）；`:60-74` 延时 1500ms 后 `process.kill(pid,'SIGTERM')`，**只杀自己**。两阶段协议：`prepareRestart`（router `admin/system.ts:294-309`，一次性 intentToken）→ `requestRestart`（`:311-325`，`SELECT … FOR UPDATE` 事务内校验 token 摘要/payload hash/期望 revision/目标实例）→ post-response 经 Next `after()`（router `:66-67` 注入 `afterResponse`）落 `signaled` 再定时 SIGTERM。收敛靠 `platform_instance_heartbeats` + `platform_instance_revision_states`（`instances.ts:59,84`，域枚举 `:66-75`）自动把 `pending_restart` 回收成 `active`（`systemService.ts:255-280`）。
  - **重要澄清**：仓库里**没有任何 supervisor 进程**。`scripts/serverLauncher/startServer.js:208-216` 只 spawn 一次 `/app/server.js`，不循环。真正把进程拉回来的是 `docker-compose/enhanced/docker-compose.yml:92` 的 `restart: always`。`PLATFORM_OIDC_RESTART_MODE=supervisor` 是**运维承诺**，不是代码路径 —— 裸 `node server.js` 下点"重启"就是杀死服务。
- **系统状态页已在服务端返回 feature flags 但前端不再渲染**：`services/platformSystem/adminService.ts:430-439` + 契约 `contracts/adminSystem.ts:150-161`；`grep -rn "system\.flags" src` **零命中** → `packages/locales/src/default/admin.ts:2198-2206` 的 9 个 `system.flags.*` 是**死键**。模块页可直接接管这条数据通道与这批文案。
- **上游 onboarding 不适合承载首启向导**：`src/routes/onboarding/**` 是 per-user 引导，挂在 `src/spa/router/desktopRouter.config.tsx:1069-1091` **和** `mobileRouter.config.tsx:494-512`（两个 upstream 文件，且 desktop 两份配置受 `desktopRouter.sync.test.tsx` 守护）。仓库里也**不存在 `/setup` 路由**。

### B8. 顺带发现（与 E1/E2 交叉核对）

- 匿名访客也在以 **30s** 周期轮询 `platform.getPublicSnapshot`，登录用户额外 **60s** 轮询 `platform.getCapabilities`（`useEnterprisePlatformData.ts:20-27,113-131`）。`getCapabilities` 内部走 `resolveManagedResourceReadinessCached`（`services/managedResourceCapabilities.ts:39-61`，TTL 30s + single-flight），注释 `:29-38` 说明：AI readiness 探针会解密**每一个**已发布 provider 的密钥，没有缓存就会让解密量随「客户端数 × provider 数」增长。**这是长期在线的常驻 CPU 成本，值得单独核算。**
- `locales/zh-CN/admin.json` 244KB、`locales/en-US/admin.json` 308KB（`packages/locales/src/default/admin.ts` 4031 行）。命名空间**按需懒加载**（`src/utils/i18n/loadI18nNamespaceModule.vite.ts:10-11` 的 `import.meta.glob` 惰性 loader），只在打开 `/admin` 时下载 —— 但乘以约 18 个 locale 目录仍计入镜像体积。
- `output: 'standalone'` 仅在 `DOCKER === 'true'` 或 `NEXT_BUILD_STANDALONE === '1'` 时启用（`src/libs/next/config/define-config.ts:28-31,62`）。Next 侧路由表按构建固定，但**几乎全部产品路由都是 SPA 客户端路由**，Next app 只有 `(backend)` / `[variants]` / `spa` / `spa-auth`。

---

## C. 推荐接缝（改动最少、对上游合并最友好）

> **[fork]** = 二开独有；**[upstream]** = 上游文件（需谨慎小改）。

### C1. 模块定义：一张常量表 **[fork·新增]**
`packages/const/src/platform/modules.ts`（与 `permissions.ts` / `errorCodes.ts` / `featureFlags.ts` 同目录）：
```
PLATFORM_MODULES = { audit, moderation, networkProxy, stats, branding, identity,
                     managedAgents, managedSkills, managedConnectors, managedAi,
                     settingsPolicy, taskTemplates }        // users/system/auth = core，不可关
CORE_MODULE_IDS: ReadonlySet<ModuleId>
MODULE_BY_ADMIN_ROUTER_KEY: Record<string, ModuleId>        // 'audit'->'audit', 'contentModeration'->'moderation', ...
DEFAULT_PLATFORM_MODULES: Record<ModuleId, boolean>          // 全 true，与现有 flag "默认 ON" 一致
```
env 解析并入现有 `apps/server/src/enterprise/featureFlags/parseEnterpriseFeatureFlags.ts` **[fork]**（沿用"只有显式 off 才关"），形如 `PLATFORM_DISABLED_MODULES=audit,moderation`（单变量，比 12 个布尔变量更适合 docker 参数）。

### C2. 生效值解析：照抄基础设施卡 **[fork·新增]**
`apps/server/src/enterprise/services/moduleSettings/`：
- 存储：新表 `platform_module_settings`，`id='global'` 单例 + jsonb `modules` + CAS `revision` + `updatedBy`（模板 = `platform_auth_settings` / `platform_sidebar_layout`）。
- 规则：`effective = merge(DEFAULT_ALL_ON, envDisabled, dbRow?.modules)`；**行缺失 ≠ 全关**（照 `platform_task_templates` 的"空有语义"先例显式写清）。env 优先级建议为**强制覆盖**（运维用 docker 参数一定能把某模块摁死，与基础设施卡的 `enabled` 语义相反但更符合"容器参数是最后手段"的直觉）—— 这一点需指挥官拍板，两种都可实现。
- 缓存：`DomainConfigCache` TTL 30s + `publishPlatformConfigInvalidation('modules')`（复刻 `snapshot.ts:253-311`）→ 跨实例热刷新。

### C3. 服务端唯一守卫点 **[fork·1 处]**
`apps/server/src/enterprise/guards/platformPermission.ts:200` 之后插入：
```
const moduleId = MODULE_BY_ADMIN_ROUTER_KEY[path.split('.')[0]]   // 'audit.listLogs' -> 'audit'
if (moduleId && !(await isModuleEnabled(moduleId))) throw PLATFORM_MODULE_DISABLED  // FORBIDDEN
```
一处改动覆盖 214 个带权限的 admin procedure。用户端 `platform.*` 另在对应 sub-router 上加同一 helper（3-4 处）。

### C4. 新错误码 **[fork·2 处]**
`packages/const/src/platform/errorCodes.ts` 增 `PLATFORM_MODULE_DISABLED`；`apps/server/src/enterprise/guards/enterpriseErrors.ts:30-66` 的映射表补 `FORBIDDEN`；`src/enterprise/client/errors/mapEnterpriseError.ts` 的 `ACTION_BY_CODE` 加一行 `→ 'none'`；locale 加 `enterprise.error.PLATFORM_MODULE_DISABLED`。写路径 toast 自动生效（`runAdminMutation.ts`），**无需改任何页面**。

### C5. 客户端下发 **[upstream 2 处 + fork 若干]**
- **[upstream]** `packages/types/src/serverConfig.ts` 的 `EnterprisePublicServerConfig`（:59-71）加 `disabledModules?: string[]`。
- **[upstream]** `apps/server/src/globalConfig/index.ts:133` 那一行 `enterprise: {...}` 补该字段（**同一行块，已经是二开改过的区域**）。因为 `getServerGlobalConfig()` 已是 async 且已 await DB（`:141`），可以直接 await 模块快照 —— **刷新页面即生效，无需重启**。
- **[fork]** `packages/types/src/platform/capabilities.ts` 的 `PlatformFeatureCapabilities` 加 `modules: Record<ModuleId, boolean>`，`services/platformCapabilities.ts:55-59` 一并填充。
- **[fork]** 新建 `src/enterprise/client/boot/getDisabledModules.ts`，与 `isPlatformAdminBootEnabled.ts` 同风格同步读 `window.__SERVER_CONFIG__`。

### C6. 前端三处降级 **[fork·全部]**
1. **菜单隐藏**：`nav/adminNavMeta.ts` —— `AdminNavItem` 加 `moduleId?`；`filterAdminNavByPermissions` 增第三参 `disabledModules`（默认空集，向后兼容），在 `hideFromNav` 判断旁多一条 `continue`。调用点仅 `AdminSideNav.tsx:67-70`。
2. **直链降级**：`gates/AdminPermissionOutlet.tsx:50-56` —— 命中目录项且模块关闭 → 渲染 `AdminModuleDisabledSurface`（由 `AdminFeatureOffSurface` 复制改造，文案 `module.off.title/desc/howTo`，副行给出"在 系统 → 模块 中启用，或设置 `PLATFORM_DISABLED_MODULES` 后重启"）。**不要用 404** —— 404 会让运维以为是 bug。
3. **页内 tab / 卡片**：照抄 `SystemGeneralPage.tsx:53-66`，把 `canRead` 换成 `canRead && moduleEnabled`。

### C7. 必须改的 upstream 文件清单

| 文件 | 改动 | 理由 | 冲突风险 |
|---|---|---|---|
| `packages/types/src/serverConfig.ts` | `EnterprisePublicServerConfig` 加 1 个可选字段（:59-71） | boot 期同步下发的唯一通道；该 interface 本身是二开新增 | 低 |
| `apps/server/src/globalConfig/index.ts` | `:133` 的 `enterprise: {...}` 补 1 个字段 | 同上的生产端 | 低（已是二开区块） |
| （可选）`src/store/serverConfig/selectors.ts` | 加 1 个 selector | 让页面按项目范式读 | 低（纯新增行） |
| （可选）`tests/setup.ts` | 决定模块开关的测试基线 | 见 D.7 | 低 |

其余一律落在 `src/enterprise/**`、`apps/server/src/enterprise/**`、`packages/const/src/platform/**`、`packages/types/src/platform/**`、`packages/locales/src/default/admin.ts`、`packages/database/src/schemas/platform/**` —— **全部 fork-only**。

### C8. 向导 / 模块页规格（UX，无代码）

**放置**：`/admin/system/modules`，`system` 分组新 nav item（读 `SYSTEM_READ`、写 `SYSTEM_OPERATE`），组件在 `adminPageCatalog.tsx` 里 `lazy()`。**不新建顶级 `/setup`**（要改两个 upstream router config 并过 `desktopRouter.sync.test.tsx`）。

**首启引导**：`platform_module_settings` 行缺失（或另加 `setupCompletedAt`）时，`/admin` 概览页顶部渲染一张引导卡（"完成 3 步部署配置：选择模块 → 检查基础设施 → 完成"），CTA → `/admin/system/modules?wizard=1`；该参数让同一页面进入**三步向导态**（步骤条 + 下一步），完成后写标记并消失。**一个组件同时服务向导与日常设置**，符合 DESIGN.md「Layered, not split — 不做 simple/pro 双版本」。

- **标题/描述**：`modules.title` =「模块」；`modules.description` =「关闭用不到的模块可以降低内存与后台任务开销。大部分改动保存后刷新页面即可生效。」
- **字段**：每个可关模块一行 —— `@lobehub/ui/base-ui` 的 `Switch` + 名称 + 一行说明 + 右侧 `StatusBadge`（`primitives/StatusBadge.tsx`）显示「运行中 / 已停用 / 待重启」。核心模块（用户、系统、安全与认证）显示为禁用态 + tooltip「核心模块不可关闭」。
- **来源标记**：某模块被 env 强制关闭时，Switch 禁用并挂「由环境变量控制」标签（复用 `src/features/PlatformSettingSourceBadge/`），tooltip 给出确切变量名 —— 与基础设施卡的 env 覆盖范式一致。
- **热生效 vs 需重启**：模块行分两组。**热生效组**（审计/内容审计/统计/品牌/任务模板/技能/连接器/受管资源等纯 tRPC + UI 的模块）保存后提示「已保存，刷新页面生效」；**需重启组**（网络代理 = mihomo 子进程、安全与认证 = Better Auth 插件集、以及任何由 `instrumentation.register()` 拉起的设施）保存后置 `pendingRestart`，顶部出现横幅 + 「立即重启」按钮（复用 `identityProviderRestart.ts:97-108` 的三态；`restart.supported === false` 时改文案为「请在容器编排中重启服务」）。
- **四态**：loading = 骨架（DESIGN.md Motion 段：优先系统专用 loader，不用临时 spinner）；empty 不存在；error = `AdminPageTemplate.banner` + 重试；success = toast「已保存模块设置」（DESIGN.md：不写"成功"，直接说变了什么）。
- **确认**：关闭 audit / moderation 这类合规模块走 `DangerConfirm`（`primitives/DangerConfirm.tsx`），正文说明「已产生的记录不会删除，只是停止采集与查询入口」—— 对应 DESIGN.md「先承认处境 → 恢复控制 → 给下一步」。
- **文案键**：`admin` 命名空间新增 `modules.*`；`system.flags.*`（现为死键）可回收作模块名备用译文。
- **写操作**：走 `runAdminMutation`（自带 reauth 重试 + 单一失败面）+ CAS `revision`，避免两个管理员互相覆盖。

---

## D. 不要碰 / 风险

1. **不要按模块条件挂载 tRPC router**（`apps/server/src/enterprise/routers/admin.ts:172-195`、`apps/server/src/routers/lambda/index.ts:88` 保持原样）。`reconcile.ts:57-65` 会对 215 条全部报 `invalid lambda mount`；`AdminRouter` 类型会随 env 漂移；且 B4 已证明 `NOT_FOUND` 的降级形态最差（永远点不通的重试按钮）。
2. **不要动 `src/spa/router/desktopRouter.config*.tsx` 与 `mobileRouter.config.tsx`**（desktop 两份必须同步，`desktopRouter.sync.test.tsx` 守护，改错 = 白屏）。向导放 `/admin/**` 完全绕开。
3. **不要把模块开关塞进上游 `FEATURE_FLAGS`**（`packages/app-config/src/featureFlags/schema.ts`）：userId 灰度语义 + 54 处消费点 + 上游高频变更 = 合并冲突面最大。
4. **`ENABLE_PLATFORM_ADMIN=0` 的既有行为不得破坏**：整台控制台不注册路由、所有 admin procedure 抛 `ADMIN_FEATURE_DISABLED`。模块开关是它的**下一层**。
5. **重启按钮的地基是运维承诺，不是代码**：`PLATFORM_OIDC_RESTART_MODE=supervisor` 只做 `process.kill(self,'SIGTERM')`，靠 compose `restart: always`（`docker-compose/enhanced/docker-compose.yml:92`）拉回。**裸 `node server.js` 部署下点"重启"= 服务死亡**。若复用，必须保留 `restartCapability` 的 `supported:false` 分支与其文案，并考虑把 env 名泛化为 `PLATFORM_RESTART_MODE`（保留旧名兼容）。
6. **"行缺失"不能被读成"全关"**：这是最容易写出的 fail-closed 事故（新装即全模块不可用）。显式按 `platform_task_templates` 的先例写测试钉住。
7. **测试基线**：`tests/setup.ts:74-86` 把 9 个 `ENABLE_*` 强制 `'0'`。新增模块开关若默认 ON，则单测环境下"企业 flag 全关但模块全开"是一种生产里不存在的组合；需明确决定并在 setup 里写死，否则会掩盖回归。
8. **权限与模块正交**：模块关闭时**不要**顺手撤销 RBAC 权限（重开需重新播种角色，见历史多次"新权限须重播种"的坑）。只做展示层与请求层拦截。
9. **`admin.ts:48-50` 的导入期副作用**在运行期禁用下仍会执行；若要靠它省资源，需确认早退不会让**已启用**模块的 readiness 探针失效（`services/aiCatalog` / `connectorCatalog/runtimeReadiness` / `skillCatalog`）。
10. **vite dev 无 `__SERVER_CONFIG__`**：基于 boot 通道的模块隐藏在 `bun run dev:spa` 直连下表现为"全关"，必须走 Debug Proxy 验证。
11. **KEK/Vault 与 `NEXT_PUBLIC_S3_FILE_PATH` 是显式 env-only**（`docs/enterprise/infra-settings.md:25-28`，理由是 confused deputy）。模块集合若能关掉审计/内容审计这类合规闸门，**同一个 confused-deputy 问题成立** —— 建议合规相关模块的关闭只允许 env，DB 侧只读展示。

---

## E. 需要真机核实的事项

1. **关闭一个模块实际省多少**：在 `aihub-demo-app` 里对比 `next-server` RSS（基线 ≈700MB）与 idle CPU（≈4-5%），分别在 audit / moderation / networkProxy 关闭时测。静态勘探无法给数字。
2. **`admin.*` 按页 chunk 的实际字节**：需一次 `bun run build` 后统计 `dist/assets/*`，才能量化"关闭模块省下的下载量"。本报告只给了源码行数。
3. **`platform.getCapabilities` / `getPublicSnapshot` 轮询的真实成本**（每次 SQL 条数、P95、以及 provider 密钥解密量），决定是否值得合并请求或延长周期（当前 60s / 30s）。
4. **热生效 vs 需重启的模块分组是否准确**：需逐个确认 `apps/server/src/enterprise/jobs/` 的 10 个 job 的启动谓词能否被模块开关短路，以及 mihomo 子进程是否真能靠 `engine_generation` 广播在不重启进程的情况下停掉。
5. **SIGTERM 重启在 `docker-compose/enhanced` 下的实际恢复时长**（含 `docker.cjs` 迁移与 `platform-oidc-lkg-init`），决定「立即重启」的文案与超时。
6. **env 覆盖 vs DB 优先的最终语义**（C2 里两种都可实现）需指挥官拍板后再写测试。
7. **`platform_module_settings` 迁移**：`drizzle-kit generate` 在本仓已知损坏（schema 会吃 test 文件），需手写迁移并核对 `folderMillis` 大于所有并行会话已应用的值。
