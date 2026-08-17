# G0b — round-1 实测（batch 工作树已拷入）

`DOCKER=true next build` 9.6 min compile，exit 0。SPA stub 仍在。测量：standalone `node server.js`，`Module._cache` via CDP，`.env.development`，PORT=3033，Ready+15s / 请求后+10s。每配置 3 次 boot；xact 只在 rep1 采 60s idle。

standalone **532.5 MB / 604M du / 20491 files**。仍含 `src/` 22.7、`packages/` 31.7、`apps/server` 15.2、**`apps/desktop` 27.7**、`apps/cli` 1.3、`e2e` 0.73、`tests` 0.04。新 excludes（`apps/desktop/**` 等、无 `dist/**`）**没裁掉 desktop/cli/e2e**。`platform.ts:52` cwd-trace 警告仍在（27626 files）。

## A. 配置 × 指标

RSS/heap = `process.memoryUsage()` 字节→MB。chunk = `.next/server/chunks` 已 require。gateway = 是否出现 skip 行 / boot 期 discord.js 路径数。

| cfg | boot RSS MB (3) | after1st RSS | boot heap | after heap | boot chunks / MB | boot mods | after mods | Ready ms (3) | idle xact/s | gateway |
|---|---|---|---|---|---|---|---|---|---|---|
| **(a) default** | 473.6 / **500.5** / 503.0 | 469.6 / **657.7** / 668.9 | 233 / **237** / 250 | **374** | 729 / **76.16** | **2015** | 2098 | 2235† / **1114** / 1072 | **0.45** | 启动（无 skip；boot discord.js=**313**） |
| **(b) standard** | 447.3 / **470.6** / 471.4 | 624.9 / **663.8** / 672.4 | 226 / **229** / 229 | **385** | 724 / **74.32** | **1458** | 2093 | 1049 / **1106** / 1110 | **0.45** | **未启动**；`[modules] worker gatewayService skipped: module bots disabled`；boot discord.js=**0** |
| **(c) minimal** | 450.6 / **456.6** / 469.1 | 629.3 / **643.6** / 647.9 | 198 / **212** / 213 | **364** | 688 / **71.73** | **1422** | 2057 | 1068 / **1101** / 1154 | **0.217** | **未启动**；同上 skip + 另 8 条 worker skip；boot discord.js=**0** |

† default r1 冷启动。snap 全是 HTTP 200；冷 5415ms，热中位 1.2–1.6s。加粗=中位。

**读数：**
- boot 内存：minimal 中位 456.6 vs default 500.5（**−44 MB**）；standard −30 MB。**第一次 `getPublicSnapshot` 后三档都回到 ~640–660 MB**，preset 的 RSS 优势基本吐回去。
- boot 模块：default 2015 → standard 1458（−557）→ minimal 1422（−593）。chunk 字节 default 76.16 → min 71.73（**−4.43 MB**）。
- 请求后 standard/minimal 模块飙到 2093/2057，且 **discord.js 从 0 变成 313**（只多 2 个 chunk，多半是 external `require('discord.js')`）。
- xact：default=standard=0.45（audit 仍开）；minimal 0.217（audit/connectors/proxy skip）。
- minimal skip：`connectorCatalogReadiness` `auditExport` `auditRetention` `agentRollout` `connectorRuntimeAudit` `connectorSecretCleanup` `sharedOAuthKeepalive` `networkProxyEngineSupervisor` `gatewayService`。

## B. 功能

| 调用 | (c) minimal | (a) default |
|---|---|---|
| `GET /trpc/lambda/knowledgeBase.getKnowledgeBases` | **403** body 含 `PLATFORM_MODULE_DISABLED` + `moduleId: knowledgeBase`（非 404/500） | **401** `UNAUTHORIZED`（非 500） |
| `POST /api/agent/gateway/start` + `Bearer $KEY_VAULTS_SECRET` | **403** `{"error":"PLATFORM_MODULE_DISABLED","moduleId":"bots"}` — **不是**约定的 200 `{disabled:true}`（`webapiModuleGate` 先于 `gatewayStart`） | （未测 start） |
| `GET /trpc/lambda/platform.getPublicSnapshot` | 200 | 200 |

## C. Provenance（`Module._cache` 路径计数）

| dep | (a) boot | (a) after | (c) boot | (c) after | (b) 同 (c) 形态 |
|---|---|---|---|---|---|
| `discord.js` | **313** | 313 | **0** | **313** | boot 0 → after 313 |
| `sharp` | **14** | 14 | **14** | 14 | 不变 |
| `@aws-sdk/client-s3` | **7** | 7 | **7** | 7 | 不变 |
| `xlsx` | 1 | 1 | 1 | 1 | 不变 |

preset 只挡住 **gateway 的 boot import**。sharp / S3 / xlsx 仍在全档 boot set。首次匿名 snapshot 会把 discord.js 拉回来。

## D. preloadEntriesOnStart

**not run**（一轮 build + 9 boot + 功能已满 60 min）。

## E. 坏了什么

1. `aiCatalogReadiness` 全档（只要 managedAi 开）`failed to start { errorClass: 'ReferenceError' }`。
2. 构建期 `TypeError: (0 , c.onNetworkProxySnapshotChange) is not a function` @ `networkProxy/egress/scope.ts:138`（page collect，build 仍成功）。
3. `POST /api/agent/gateway/start` 在 bots=off 时是 **403**，不是文档/handler 写的 200 `{disabled:true}`。
4. Docker excludes **未**去掉 `apps/desktop` 等；cwd-trace 仍把 `src/` `packages/` 打进 standalone。
5. (b)/(c) 首次 snapshot 后 discord.js 仍进进程 — 关 boot worker ≠ 关请求路径。
6. `[module-settings] / [infra-settings] / [network-proxy] load failed`（本地无 PLATFORM_* 表/密钥），走 env fallback。
