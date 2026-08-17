# E1 — 服务端运行时热点实测报告(boot / idle / 内存构成)

测量环境:临时容器 `aihub-perf`(镜像 `aihub:demo`,DB=`lobechat_perf` 为 `lobechat_demo` 全量拷贝,
Redis DB 3,无 `/app/.lobe` volume ⇒ 无 network-proxy 引擎)。对照组为线上体验容器 `aihub-demo-app`
(只读采样 `/proc`,未做任何修改)。原始数据在 `e1_raw/`(`loaded_boot.json` / `profile_idle.txt` /
`cpusample.out` / `cpu2.out` / `cdp.mjs`)。容器已 `docker rm -f`,`lobechat_perf` 库保留。

---

## A. 摘要(给指挥官决策用)

1. **idle 700MB RSS 里 ~65% 是"加载进来的 JS 本身"**:冷启动 next-server `rss=449MB / heapUsed=307MB`;
   heap snapshot 292.6MB 中 **string 171.9MB + code 43.3MB + closure 23.4MB**,其中 **150.4MB 是 turbopack chunk 的源码字符串**。
2. **启动即加载 1876 个模块 / 78.0MB chunk 字节(磁盘 chunk 共 2035 个 /123MB,即 63% 的字节在 boot 期就被 require)**。
   经验系数:**每 1MB chunk 磁盘字节 ≈ 2.5–2.8MB RSS**(源码字符串 1.9× + 字节码 0.55× + 闭包)。
3. **6 个 `[root-of-the-server]__*.js` 巨块(各 4.14MB)在 boot 期全部加载,单块在 heap 里占 7.72MB
   (含中文 ⇒ V8 退化为 two-byte string,×2 放大),合计 46.3MB**。它们内部同时含 tiktoken / slack /
   discord / telegram / mihomo / i18n / model-bank 标记 ⇒ **只做"env 关掉执行"不省内存,必须把模块移出 root chunk 图(动态 import)**。
4. **idle CPU 的唯一来源是 11 个企业后台 worker**(实测:worker 未启动 0.075% + 0.2 xact/s;启动后 **1.57% + 2.35 xact/s**;
   demo 实测 0.43%–1.65% + 2.23 xact/s)。其中 **agentRollout 2s / secretRewrap 2s / auditExport 3s /
   auditRetention 3s / connectorRuntimeAudit 5s / connectorSecretCleanup 5s** 六个高频轮询,成功时**不退避**。
5. **Top5 内存贡献** + 开关缝位置:
   - ① root mega-chunk ×6(46.3MB heap)— 构建产物,seam 在 **fork-only** 的 `apps/server/src/enterprise/routers/platform.ts` 顶层副作用 + 各 `enterprise/services/*` 的静态 import。
   - ② Bot/Gateway 图(discord.js 1.19MB + discord-api-types 0.24 + @discordjs/builders 0.15 + telegram/slack/qq adapter)— seam 在 **upstream** `src/instrumentation.ts:52-68`(`GatewayService` 无 feature flag)。
   - ③ model-bank(`packages_model-bank_src_*` 1.07MB chunk)— **upstream**。
   - ④ i18n/locales 中文字符串(导致 two-byte string 放大)— **upstream** `src/server/translation.ts` 0.09MB + 各 chunk 内联文案。
   - ⑤ AWS SDK S3 + sharp(10.0MB chunk + 0.72MB native)boot 期即载 — **upstream**。
   - (⑥ mihomo 子进程 43MB RSS,**fork-only**,已由 network-proxy 开关控制。)
6. **Top5 CPU 贡献**(idle):① secretRewrap 2s(**无 flag**)② agentRollout 2s(ENABLE_PLATFORM_MANAGED_AGENTS)
   ③ connectorCatalog/runtimeAuditWorker 5s(**无 flag**)④ auditExport+auditRetention 3s(ENABLE_PLATFORM_ADMIN)
   ⑤ 两条 30s 心跳 + networkProxy 15s/30s/60s 探针。**全部 seam 在 fork-only 文件**。
7. 最小改动、最大收益的一处缝:`apps/server/src/enterprise/routers/platform.ts:58-83` —— 11 个 worker 全部是该文件的
   **模块顶层副作用**,改成一个受 env 控制的注册表即可一次性关掉 idle CPU/DB 负载。**该文件是 fork-only,零 upstream 冲突。**

---

## B. 发现(按重要性)

### B1. 内存:heap 的 73% 是"被加载的 JS"本身,不是业务数据

冷启动(无任何请求)`process.memoryUsage()`:

```
rss 449,454,080 | heapTotal 314,064,896 | heapUsed 307,384,320 | external 5,442,941 | arrayBuffers 979,994
```

`v8.getHeapSpaceStatistics()`:`old_space=136.2MB` / **`large_object_space=137.3MB`** / `trusted_space=14.5MB` /
`code_space=5.1MB`。heap snapshot(200MB 文件)按 node type 聚合,总计 292.6MB:

| type | MB |
|---|---|
| string | **171.9** |
| code | 43.3 |
| closure | 23.4 |
| array | 17.8 |
| object | 16.6 |
| object shape | 10.9 |
| 其余 | 8.7 |

其中 **1312 个"模块源码"字符串 = 150.4MB**;**86 个 >256KB 的字符串 = 127.6MB**(正好落在 `large_object_space`)。
Top 命名节点:

```
7.72 MB × 6   string: module.exports=[362562,(e,t,a)=>{t.exports=e.   ← [root-of-the-server]__*.js
4.94 MB × 1   string: module.exports=[413945,...
2.93 MB × 5   string: module.exports=[149185,...
11.79 MB      closure: native_bind
10.87 MB      array: (object properties)
```

**注意 2× 放大**:`[root-of-the-server]__1b-p672._.js` 磁盘 4.14MB,heap 里 7.72MB —— chunk 里内联了中文文案/
locale/branding 字符串,V8 无法用 one-byte 表示,整块源码退化为 two-byte string。**降低中文内联比例或把中文
locale 移出服务端 chunk,可直接砍掉一半源码内存**。

### B2. Boot 期加载面:1876 模块 / 87.4MB,占磁盘 chunk 的 63%

```
total modules 1876 | chunks 572 files 78.0 MB | node_modules 1232 files 9.2 MB | other 72 files 0.2 MB
磁盘: /app/.next/server/chunks = 2035 files / 123 MB;/app/.next/server = 243 MB;/app/node_modules = 268 MB;镜像 1.72 GB
```

按 chunk 名分组(证据 `e1_raw/loaded_boot.json`):

| MB | files | 组 |
|---|---|---|
| 35.66 | 188 | `[root-of-the-server]__*`(含 6×4.14MB 巨块) |
| 35.47 | 201 | 匿名 `_<hash>._.js` |
| 1.68 | 18 | `node_modules__pnpm_*` |
| 1.58 | 18 | `packages_*` |
| 1.02 | 1 | `packages_model-bank_src_*` |
| 0.35 | 1 | `0prf_xlsx_xlsx_mjs`(xlsx,boot 期就载) |
| 0.25 | 7 | `apps_server_src_enterprise_*` |

boot 期 node_modules Top:`next 3.41MB` / **`discord.js 1.19MB`** / `undici 0.81` / `@img/sharp-linux-arm64 0.51`
/ `@smithy/core 0.40` / `@aws-sdk/client-s3 0.34` / `@xmldom/xmldom 0.25` / `discord-api-types 0.24` /
`sharp 0.21` / `ajv 0.20` / `@discordjs/builders 0.15` / `ws 0.13`。

**特征字符串扫描的结论(重要)**:tiktoken 命中 6 个文件 24.86MB = 恰好那 6 个 root 巨块;slack(9 文件)、
discord(9)、telegram(7)、mihomo(11)同样以这 6 块为主体。**即:bot 适配器、tiktoken、mihomo 客户端、i18n、
model-bank 都被 turbopack 编进了"每次都加载的 root chunk"**。因此:

> **只加 `if (!flag) return;` 的守卫不省内存,只省 CPU。要省 RSS 必须把这些子系统改成 `await import()`,
> 让 turbopack 把它们切成独立 chunk。**

### B3. Boot 时间线(容器 StartedAt=`07:12:13.416`,`docker logs -t`)

| 相对时间 | 事件 | 证据 |
|---|---|---|
| +0.11s | 首条日志(startServer.js 起) | `07:12:13.523 🌐 DNS Server` |
| +0.18s→+0.20s | `docker.cjs` 迁移(24ms,无待应用迁移) | `13.594 Start to migration` → `13.618 pass` |
| +0.37s | **Next.js Ready(开始监听)** | `13.789 ✓ Ready in 0ms` |
| +0.59s | platform RBAC seeding 完成 | `14.002 [platformBootstrap] platform RBAC seeded` |
| +0.66s | identityProvider bootstrap 完成 | `14.074 [identityProviderStartup] ...` |
| **+4.31s** | **GatewayService 启动完成(3.6s 空档)** | `17.721 [GatewayService] Started successfully` |

boot 期 CPU 累计 399 ticks ≈ **4.0 s CPU**。**3.6s 的 Gateway 空档 = 加载 discord.js/telegraf/slack 适配器 +
扫库**(`src/instrumentation.ts:52-68` → `apps/server/src/services/gateway/index.ts:107` →
`../bot/platforms` `platformRegistry.listPlatforms()`)。这段没有任何 feature flag,只被 `VERCEL_ENV` /
`NODE_ENV` / `DATABASE_URL` 挡。

### B4. idle CPU:100% 来自 11 个企业 worker(实测隔离)

关键实验(clean 重启的 `aihub-perf`,`aihub-demo-app` 全程未动):

| 阶段 | next-server CPU | `lobechat_perf` xact/s |
|---|---|---|
| 启动后完全无请求(**worker 未启动**) | 3 ticks/40s = **0.075%** | **0.20** |
| 打一次 `GET /trpc/lambda/platform.getPublicSnapshot`(触发 worker) 后 idle 60s | 94 ticks/60s = **1.57%** | **2.35** |
| 对照:`aihub-demo-app` idle | 0.43%(75s 窗) / 1.65%(60s 窗) | 2.23(`lobechat_demo`,tup_returned 188/s) |

**根因**:11 个 worker 是 `apps/server/src/enterprise/routers/platform.ts` 的**模块顶层副作用**
(`platform.ts:58-83`),tRPC 路由树一被加载就永久启动;`persistentWorkerScheduler` 成功时
`delayMs = options.baseIntervalMs`,**不做 idle 退避**(`persistentWorkerScheduler.ts:54-75`)。

CPU profile(60s idle,1ms 采样,28412 样本)显示 **99.94% `(idle)`**,余下样本零散落在 `pg/lib/result.js`
`addCommandComplete`、`buildQueryFromSourceParams`、`processTimers` —— 与"CPU 全部是 DB 轮询往返"一致
(`e1_raw/profile_idle.txt`)。注意该 profile 在 worker 未启动的状态采得,请以上表的 tick 实测为准。

#### 周期表(name / interval / file:line / 可否 flag 关 / idle 成本)

| worker / timer | 周期 | file:line | flag 守卫 | idle 成本 |
|---|---|---|---|---|
| agentRollout | **2s** | `apps/server/src/enterprise/jobs/agentRollout.ts:12,48` | ENABLE_PLATFORM_MANAGED_AGENTS | 0.5 query/s |
| secretRewrap | **2s** | `apps/server/src/enterprise/jobs/secretRewrap.ts:12,49` | **无** | 0.5 query/s |
| auditExport | **3s** | `apps/server/src/enterprise/jobs/auditExport.ts:13,55` | ENABLE_PLATFORM_ADMIN | 0.33 query/s |
| auditRetention | **3s** | `apps/server/src/enterprise/jobs/auditRetention.ts:13,55` | ENABLE_PLATFORM_ADMIN | 0.33 query/s |
| connectorCatalog runtimeAuditWorker | **5s** | `apps/server/src/enterprise/services/connectorCatalog/runtimeAuditWorker.ts:9,68` | **无** | 0.2 query/s |
| connectorCatalog secretCleanupWorker | **5s** | `.../secretCleanupWorker.ts:12,86` | ENABLE_PLATFORM_MANAGED_CONNECTORS | 0.2 query/s |
| identityProviderTestAttemptCleanup | 60s | `apps/server/src/enterprise/jobs/identityProviderTestAttemptCleanup.ts:6,55` | ENABLE_DATABASE_OIDC | 可忽略 |
| brandingAssetCleanup | 5min | `apps/server/src/enterprise/jobs/brandingAssetCleanup.ts:9,30` | **无** | 可忽略 |
| sharedOAuthKeepalive | 10min | `apps/server/src/enterprise/jobs/sharedOAuthKeepalive.ts:14,29` | **无** | 可忽略(但会发外网请求) |
| platformInstanceRegistryCleanup | 60min | `apps/server/src/enterprise/jobs/platformInstanceRegistryCleanup.ts:6,117` | ENABLE_DATABASE_OIDC | 可忽略 |
| platformInstance heartbeat | 30s | `apps/server/src/enterprise/services/platformInstance/heartbeatRuntime.ts:91,161`(常量 `packages/database/src/repositories/platformInstance/index.ts:34`) | 任一企业 flag 开即开(`heartbeatRuntime.ts:65-79`) | 1 upsert/30s |
| identityProvider instanceRegistry heartbeat | 30s | `apps/server/src/enterprise/services/identityProvider/instanceRegistry.ts:20,230` | ENABLE_DATABASE_OIDC | 1 upsert/30s |
| networkProxy engine supervisor health | **15s** | `.../networkProxy/engine/supervisor.ts:595`(常量 `packages/const/src/platform/networkProxy.ts:140`) | 引擎已安装才启 | 本地 HTTP 探针 |
| networkProxy instanceStatusReporter | 30s | `.../networkProxy/engine/instanceStatusReporter.ts:70,88` | 同上 | 1 写/30s |
| networkProxy egress staticHealth | 60s | `.../networkProxy/egress/staticHealth.ts:10,75` | 同上 | 1 次出网探针 |
| openapi api-key cache cleanup | 10min | `packages/openapi/src/middleware/auth.ts:45` | 无(纯内存) | 可忽略 |

所有 timer 都 `.unref()`(故 `process.getActiveResourcesInfo()` 只报 `{PipeWrap:2, TCPServerWrap:1}`、
`_getActiveHandles().length=3`,不要用这个指标判断"有没有定时器")。

### B5. 子进程 / worker_threads 常驻成本

`aihub-demo-app` 进程实测(`/proc/<pid>/status` VmRSS、`/proc/<pid>/stat` utime+stime 75s 差):

| pid | 进程 | VmRSS | idle CPU |
|---|---|---|---|
| 1 | `/bin/node /app/startServer.js`(supervisor,常驻但空转) | **61 MB** | 0% |
| 27 | `next-server (v16.3.0)` | **688 MB** | 0.43% |
| 38 | `mihomo`(network-proxy 引擎 v1.19.30) | **43 MB** | 0.04% |

容器 `docker stats` 合计 673.8 MiB(共享页去重后)。`aihub-perf` 无引擎时容器 398.8 MiB。

- **`startServer.js` 父进程白占 61MB**:它只是 spawn 了 server.js 后守着;这是 upstream
  `scripts/serverLauncher/startServer.js` 的形态。
- **moderation regex worker** 是**按需**创建的(`apps/server/src/enterprise/services/contentModeration/regexWorker.ts:186`
  `ensureWorker()`),idle 时不存在,不计入常驻。
- GatewayService 无独立进程/线程,成本全在主进程的模块图(见 B3)。

### B6. 内存增长面(为何 demo 是 705MB 而冷启动只有 430MB)

实测同一镜像:

| 状态 | next-server RSS |
|---|---|
| 冷启动、零请求 | **430 MB** |
| 打一次 `platform.getPublicSnapshot` 后 | 502 MB(峰)→ 457 MB(GC 后) |
| 再打 7 条杂路由(多数 404) | 462 MB;`heapUsed=337MB`,模块数 1876→**1946**,chunk 字节 87.4→**89.4MB** |
| demo(已服务真实流量,NET I/O 33MB) | **688 MB** |

⇒ 从 430MB 到 688MB 的 ~260MB 是 **按路由懒加载进来的 chunk(SPA SSR / chat / admin / model-runtime /
文件上传)+ 请求期缓存**。这部分同样服从"1MB chunk ≈ 2.5MB RSS"的系数,**关掉一个模块 = 既省 boot 又省这段**。

---

## C. 推荐的 seam(改动最少、对 upstream merge 友好)

> 标注:**[fork]** = 二开独有文件,合并零冲突;**[upstream]** = 会与上游冲突,必须做成一行式 guard。

### C1. 【最高性价比,fork-only】worker 注册表 —— 一次性关掉全部 idle CPU/DB

`apps/server/src/enterprise/routers/platform.ts:58-83` **[fork]** 现在是 11 行裸调用。改成:

```
// 伪代码(数据结构,不是实现)
type WorkerSpec = { name: string; flag?: EnterpriseFlagKey; start: () => void };
const ENTERPRISE_WORKERS: WorkerSpec[] = [ … 11 条 … ];
startEnterpriseWorkers(process.env)  // 内部逐条判 flag + 判 DISABLE_MODULES 黑名单
```

收益(实测):**1.5% idle CPU + 2.2 xact/s → ~0.08% + 0.2 xact/s**。
同时补齐 4 个**没有 flag** 的 worker(secretRewrap / brandingAssetCleanup / sharedOAuthKeepalive /
connectorCatalog runtimeAuditWorker)。

### C2. 【fork】高频轮询 → 事件驱动 / idle 退避(算法级)

现状 `persistentWorkerScheduler.ts:54-75` 成功即按 `baseIntervalMs` 重排。两条改法(二选一或叠加):

- **idle 退避**:连续 N 次"零任务"后把 delay 指数放大到上限(如 60s),有任务时立刻回落到 2s。
  实现只需在 `options.run()` 的返回值里带 `didWork: boolean`,`scheduler` 里加 3 行。
  **零业务语义变化,idle DB 往返可降 ~90%**。
- **Postgres `LISTEN/NOTIFY`**:`platform_jobs` 插入时 NOTIFY,worker 只在收到通知或超时(60s)时跑。
  更彻底但改动面大,建议二期。

另:6 个高频 worker 各自独立连库轮询同一张 `platform_jobs` 表 ⇒ **可合并为一个 dispatcher 轮询 + 按 job type 分派**,
把 6 次/2-5s 的往返压成 1 次。

### C3. 【upstream,一行 guard】Bot / GatewayService 懒加载

`src/instrumentation.ts:52-68` 目前只判 `NODE_ENV / VERCEL_ENV / DATABASE_URL`。加一个 env 条件即可:

```
if (… && isModuleEnabled('bots'))  { const { GatewayService } = await import('@/server/services/gateway'); … }
```

因为 `GatewayService` 已经是 `await import()`,**加 flag 后 discord.js/telegraf/slack/qq 的整张图不会进内存**。
收益:boot 少 3.6s;RSS 省 ~4.2MB chunk×2.5 ≈ **10–12MB**(独立 chunk 部分);冲突面 = 1 个 `if` 条件。

### C4. 【fork + 构建】把 root mega-chunk 拆开(RSS 的大头)

`[root-of-the-server]__*.js` 6×4.14MB(heap 46.3MB)是"所有 server entry 共享的根图"。要削它:

1. **企业子系统改动态 import**:`apps/server/src/enterprise/routers/platform.ts` 顶部现在静态 import 了
   `aiCatalog / branding / connectorCatalog / managedResourceCapabilities / networkProxy / platformCapabilities /
   skillCatalog`(`platform.ts:30-46`)。把 admin-only 的分支改成 procedure 内 `await import()`,
   即可把它们踢出 root chunk。**全部 fork-only 文件**。
2. **两字节字符串**:中文文案内联导致 root chunk 在 heap 里 ×2。把 server 侧用到的 zh-CN 文案改为运行时读
   JSON(`src/server/translation.ts` 已有该形态,0.09MB),可望省下这 46.3MB 的接近一半。**[upstream 轻改]**

### C5. 【upstream,低风险】boot 期不该载的重依赖

`@aws-sdk/client-s3`+`@smithy/*`(0.74MB)、`sharp`(0.72MB 含 native .node)、`xlsx`(0.35MB)、`@xmldom/xmldom`(0.25MB)
在**零请求**时已进 `require.cache`。这些应该由"上传/图片/导入导出"路由首次命中时再载。
排查入口:哪个 boot 期模块静态 import 了 `@/server/modules/S3` / `sharp`。**[E 节标为待核]**

### C6. 【fork】supervisor 进程合并

`startServer.js` 父进程常驻 61MB 只为守 server.js。若用 `exec` 替换自身(或直接把迁移逻辑塞进 server 启动前),
可省 61MB。属 **[upstream]** `scripts/serverLauncher/startServer.js`,但改动是"spawn → execve",**要先确认
network-proxy 的 supervisor 语义(`PLATFORM_OIDC_RESTART_MODE=supervisor` 依赖父进程重启子进程)**,风险中等。

### C7. 模块关停后管理端降级(与本报告相关的一点)

`platformRouter.getCapabilities` 已经在返回 `buildPlatformCapabilities`(`platform.ts:44`),
**建议把"模块开关"并入同一个 capabilities 响应**,前端 Admin 侧统一按 capability 隐藏/置灰,
避免为每个模块加新的探测端点。这是 fork-only 的既有形状,零新增 surface。

---

## D. 不要动 / 风险

1. **不要动 `heartbeatRuntime.ts:65-79` 的 `NEXT_RUNTIME !== 'edge'` 判断**。注释里明确写了:
   曾经写成 `=== 'nodejs'` 导致 Docker 下心跳静默失效。改这里会连带打掉实例注册表/管理端"在线实例"。
2. **不要给 `secretRewrap` 直接加 `ENABLE_PLATFORM_ADMIN` 守卫**。密钥 rewrap 关系到 `PLATFORM_MASTER_KEY`
   轮换的 CAS 语义(见记忆:CAS 竞败要重基线);它应当有自己的开关,且默认**开**,只在"无平台密钥"部署里关。
3. **不要把 `.unref()` 去掉或改成 ref 定时器**——会阻止进程优雅退出。
4. **不要按 chunk 文件名做任何硬编码**(`[root-of-the-server]__1b-p672._.js` 之类是构建哈希,每次 build 变)。
5. **`ensureConnectorRuntimeCapabilityStateBootstrapped()`(`platform.ts:60-61`)注释写明 "Process bootstrap
   only — never from user capability reads (SR-003)"**,若做懒加载改造,必须保证它仍在进程级只跑一次。
6. **动态 import 化的回归风险**:tRPC procedure 内 `await import()` 会把首次调用的延迟抬高(实测
   `platform.getPublicSnapshot` 冷路径 395ms)。对登录前的匿名端点(`getPublicSnapshot`)要保留预热或保持静态。
7. `identityProviderStartup` 在 perf 容器里报了 `critical database snapshot failure` /
   `critical LKG snapshot failure`(因为没挂 `platform-oidc-lkg` volume)。**这不是产品缺陷,是我的测试环境差异**,
   但说明 IdP bootstrap 的失败路径是 non-blocking 的,可安全地做成"模块关停"。

---

## E. 未验证 / 需真机复核

| # | 项 | 状态 |
|---|---|---|
| E1 | 用户反馈的 "idle 4–5% CPU" **未复现**。两次窗口实测 next-server 为 **0.43%(75s)/ 1.65%(60s)**,mihomo 0.04%。推测 4–5% 是有活跃会话/管理端页面轮询时的读数,或宿主 Docker Desktop 的换算差异。**需要在用户现场用 `docker stats` 连续 5 分钟复采**。 | 未验证 |
| E2 | C5 中"谁在 boot 期静态 import 了 sharp / @aws-sdk / xlsx"没有定位到具体 `path:line`(chunk 已 minify,无 sourcemap)。需要用 `next build --profile` 或 turbopack 的 module graph 导出复核。 | 未验证 |
| E3 | "root mega-chunk 中企业代码 vs 上游代码的字节占比"未测(minified 无法归因)。这决定 C4 的实际收益上限。建议做一次对照构建(`ENABLE_PLATFORM_*` 全关 + 企业路由树摘除)量 chunk 差值。 | 未验证 |
| E4 | mihomo 43MB 是**无订阅/无节点**状态的读数;带大量订阅节点后的常驻内存未测。 | 未验证 |
| E5 | demo 的 688MB 里"请求期缓存(而非 chunk)"的具体占比未测——本轮 perf 容器没跑真实用户流量。要精确归因需要在 perf 上重放一段真实流量再抓一次 heap snapshot 做 diff。 | 未验证 |
| E6 | C2 的 `LISTEN/NOTIFY` 方案在多副本 + PgBouncer 下的行为未验证(当前部署是单副本直连,风险低)。 | 未验证 |
| E7 | 本轮所有内存数字来自 **arm64 (Darwin/Docker Desktop)**。x86_64 生产机上 V8 的 `large_object_space` 行为一致,但 native 模块(sharp/mihomo)大小会变。 | 未验证 |
