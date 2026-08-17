# G0 — lazy() 是否拆 server chunk？谁把重依赖热启动进来？

工作树 `AIHub-worktrees/spike` @ main d1fc9295d2。只跑了 `DOCKER=true next build`（**未跑 vite SPA**，stub 了 `spaHtmlTemplates.ts` / `authHtmlTemplate.ts`）。首次 collect 缺 `KEY_VAULTS_SECRET`，source `.env.development` 后成功。测量：`Module._cache`（instrumentation 的 `require.cache` 是另一份，滤不到 chunk）。

## A. lazy() 裁决

**works, but barely — 不要指望 4 条 optional router 砍 mega-chunk。**

| | 磁盘 `.next/server/chunks` | boot 已加载 chunk | 6× mega `[root-of-the-server]` |
|---|---|---|---|
| baseline | 2058 files / **124.08 MB** | 570 / **81.32 MB** / 1728 mods / root 187 / 36.9 MB | 6× **4.35 MB** |
| +lazy 4 路由 | 2051 / **120.46 MB** | 564 / **77.70 MB** / 1835 mods / root 179 / 36.8 MB | 6× **4.33 MB** |
| Δ | **−3.62 MB** / −7 files | **−3.62 MB** / −6 files | **−20 KB/块，合计 −0.12 MB** |

事实：
- `@trpc/server@11.18` **导出 `lazy`**（兼 `experimental_lazy`）。写法必须 `.then(m => m.xxxRouter)`（`image/index.ts` 有 3 个 export）。
- Turbopack **会**为 `import()` 切出独立 chunk：`lambda_knowledgeBase_ts_*.js` **6.7 KB**、`lambda_market_*.js` **71 KB**。mega-chunk **几乎不动**。
- **market 的 lazy chunk 仍在 boot set**（`mobile/index.ts:23,52` 仍静态 import `marketRouter`；`experimental.preloadEntriesOnStart=true` 预载全部 server entry）。knowledgeBase 同理（`mobile/index.ts:22,51`）。image / agentSignal 没出独立具名 chunk（多半并进匿名块）。
- 类型：`LambdaRouter = typeof lambdaRouter` 设计上保留；`ignoreBuildErrors:true` 未做 tsc。`_def.procedures` **不含** lazy 子树（在 `_def.lazy`，首次访问才 hydrate）。`reconcile.ts` 只扫 `admin.*`，这 4 条无影响。OpenAPI 是 Hono `@lobechat/openapi`，不走 tRPC procedure 枚举。
- 首次调用：expA standalone 上 **全部 `/trpc/lambda/*` 变 500**（含 `healthcheck`），根因是 standalone 缺 `@lobehub/editor` 的嵌套依赖（`es-toolkit` / `remark-cjk-friendly`）。baseline 同一 endpoint 是 200。**无法干净证明 lazy 首次调用本身炸/不炸**——更像 D 的 tracing-excludes 副作用（见 E）。

**结论给下游：** lazy() 能拆 chunk，但 (1) 另一条静态边（mobile/async/tools）会立刻把图拉回 boot；(2) 4 条 optional router 不是 4.14 MB mega-chunk 的来源；(3) 真要削 mega-chunk 必须把 **agentBotProvider / aiAgent / file / generation / agentEval / branding barrel** 做成 `import()`，不是 knowledgeBase。

## B. 副作用拆除（未做第 3 次 rebuild，源码+baseline 已够）

**关执行 ≠ 关内存。** 跳过 B 重建（前两次 compile 8.7+6.1 min；A 热编 35s。时限内两轮已满）。

- `instrumentation.ts:52-65` `GatewayService` 已是 `await import()`。注释掉只省 **执行**（扫库 / 3.6s 空档）。`discord.js` 仍会进 boot：`lambda/agentBotProvider.ts:22-23` 静态 `platformRegistry` + `GatewayService` → `platforms/index.ts:3-12` 静态 9 个 adapter → `@chat-adapter/discord/dist/index.js:22` `from "discord.js"`（`serverExternalPackages`）。baseline boot `Module._cache` 已有 **313 个 discord.js 路径**。
- `platform.ts:51-81` 14 行顶层副作用：注释掉 **调用+import** 才把 job 模块移出 *这条* 边。证据：第一次 `getPublicSnapshot` 才多加载 5 个 chunk（含 `audit_exportWorker` / `audit_retentionWorker`，+0.50 MB）。**CPU/DB 收益是真的**（E1：1.57%→0.08%）。RSS：worker 代码不是 78 MB 的大头。
- branding 静态 import 仍在（`platform.ts:35` → `branding/index.ts:3` `export * from './assetStorage'` → **sharp**）。只砍 51-81 去不掉 sharp/S3。
- baseline boot RSS 3 样本：**462.7 / 462.7 / 462.7 MB**（`memoryUsage.rss` 434 MB）。未测 B 后 RSS。

## C. 重依赖出处（boot 路径第一进口 → 修法）

| dep | 第一进口 file:line | 建议 |
|---|---|---|
| `sharp` | `enterprise/services/branding/assetStorage.ts:4`，经 `branding/index.ts:3` barrel 被 `platform.ts:35` 拉进 **每进程必载** 的 platform 路由；第二进口 `services/generation/index.ts:9` ← `lambda/generationTopic.ts:11` 等 | barrel 拆开，`assetStorage` 仅 admin 动态 import；generation 整路由 lazy |
| `@aws-sdk/client-s3` | `modules/S3/index.ts:8` ← `file/impls/s3.ts:9` ← `FileService` 被 `lambda/user.ts:57` / `file.ts` / `message.ts` / `image` 等静态挂 | FileService 内 `await import('@/server/modules/S3')`；或 file/user 路由 lazy |
| `xlsx` 0.35 MB（boot 已载 `0prf_xlsx_xlsx_mjs_*.js`） | `eval-dataset-parser/src/parsers/xlsx.ts:1` 静态 ← `parsers/index.ts` ← `agentEval.ts:1` `parseDataset` | `parseXLSX` 改 `await import('xlsx')`；或 `agentEval` lazy |
| `@xmldom/xmldom` | `file-loaders/src/utils/parser-utils.ts:1`，仅 pptx loader 用，**pptx 已 lazy** | 保持；boot 里多半是路径字符串而非执行。E1 的 0.25 MB 需对照 `Module._cache`（本次 heavy 列表未见） |
| `discord.js` | `@chat-adapter/discord` 静态 ← `bot/platforms/discord/client.ts:2` ← `platforms/index.ts:3` ← **`agentBotProvider.ts:22` + instrumentation Gateway** | `platforms/index.ts` 按 id 动态 import；`agentBotProvider` lazy |
| 11 search providers | `services/search/impls/index.ts:1-11` 全静态 ← `search/index.ts:10` ← **`routers/tools/search.ts:4`**；另一边 `toolExecution/serverRuntimes/webBrowsing.ts:5` ← `serverRuntimes/index.ts:41` 全量 register | impls 按 type `await import`；tools/search 与 webBrowsing runtime 都要切 |
| 28+ `builtin-tool-*` | `packages/builtin-tools/src/index.ts:1-34` 全量 manifest ← `aiAgent/index.ts:22` ← `lambda/aiAgent.ts:28`；以及 `toolExecution/index.ts:1` + `serverRuntimes/index.ts` 30+ runtime | manifest 与 runtime 拆包；`aiAgent` / toolExecution 改动态 import |

公共放大器：`preloadEntriesOnStart: true`（standalone `server.js` 内嵌 nextConfig）——任何 server entry 的静态图都会在 **Ready 之前** require。

## D. tracing-excludes（E3）

**根因已坐实，不是猜测：** Turbopack 警告 `networkProxy/engine/platform.ts:52` `path.resolve(process.cwd(), NETWORK_PROXY_DEFAULT_DATA_DIR_DEV)` →「Dynamic filesystem access causes tracing of the whole project」（27508 files）。import 链：`platform.ts` → `admin/networkProxySupport.ts` → `webapi/admin/network-proxy/artifact/route.ts`。所以 `/app/src` `/app/packages` `apps/desktop/build` 进 standalone。

| | standalone | src | packages | apps/desktop(+build) | apps/cli | e2e/tests |
|---|---|---|---|---|---|---|
| before | **533 MB** / 610M du / 20928 files | 22.6 | 30.6 | 27.7 (build 26.3) | 1.3 | 0.73+0.04 |
| after `outputFileTracingExcludes`（Docker 分支，镜像 Vercel 块） | **487 MB** / 557M du / 19605 files | **仍在 22.6** | **仍在 30.6** | **已消失** | **已消失** | **已消失** |

Δ **−46 MB**（du −53 MB）。`src/` `packages/` `apps/server`（15 MB）excludes **挡不住**（cwd 全仓 trace）。正确修法：`path.resolve(/* turbopackIgnore: true */ process.cwd(), …)` 或把默认目录写死到 `.cache/network-proxy`。

`node .next/standalone/server.js` **能 Ready**（`/api/version` 200），但 tRPC 全 500（见 E）。

## E. 炸了什么

1. 无 `KEY_VAULTS_SECRET` → collect page data 失败。必须带 `.env.development`。
2. SPA 模板缺失 → stub 两个 html 常量，未跑 `build:spa:*`。
3. A+D 同一次 rebuild 后 standalone 缺 `@lobehub/editor` 嵌套包，`/trpc/lambda/*` 全 500。baseline 同 URL 200。**excludes 与全仓 trace 叠加会剪掉外部包的间接文件。** 上线 excludes 前要单独验证，或先修 `platform.ts:52` 再 excludes。
4. 未跑 experiment B 重建。
5. `instrumentation` 里 SIGUSR2 用错了 `require.cache`；应以 `process.mainModule.constructor._cache` / CDP 为准。
