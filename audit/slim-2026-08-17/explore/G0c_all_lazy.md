# G0c — 全部 lambda 子路由 lazy + preloadEntriesOnStart:false

C：`lambda/async/tools/mobile` 除 `admin/platform/healthcheck/config/user`（mobile 只留 healthcheck）全部 `lazy(() => import(...))`。D：C + Docker `experimental.preloadEntriesOnStart: false`。各 3 次 default boot。G0b-(a) 作对照。

## A. 表（default，中位；3 样本）

| | boot RSS / heap | after snapshot RSS / heap | after burst RSS / heap | boot chunks MB / mods | after snap chunks / mods | burst chunks / mods | Ready ms | snap ms | lazy session cold/warm | discord / sharp / s3 @boot→after→burst |
|---|---|---|---|---|---|---|---|---|---|---|
| **G0b (a)** | **500.5** / 237 | **657.7** / 374 | —（≈650） | 76.16 / 2015 | 76.65 / 2098 | — | 1114 | 1355 | — | 313 / 14 / 7 全程 |
| **C all-lazy** | **456.3** / 222 | **493.4** / 265 | **527.5** / 255 | **60.91** / 2031 | 61.40 / 2036 | 61.63 / 2058 | 1086 | **562–646** | 58 / 78 | 313 / 14 / 7；xlsx **0** |
| **C+D no-preload** | **273.7** / 111 | **373.0** / 173 | **374.8** / 194 | **12.03** / 1368 | 24.07 / 1498 | 24.30 / 1520 | 1122 | **958–1277** | 51 / 40 | 313 / 14 / 7；xlsx 0 |

C boot RSS 三样本 444.5 / 456.3 / 459.2；D 267.1 / 273.7 / 275.0。D burst 372.2 / 374.8 / 391.7。

burst = `config.getGlobalConfig`(200) + `user.getUserState` / `session.getSessions` / `topic.getTopics` / `agent.queryAgents` / `aiProvider.getAiProviderRuntimeState` / `aiModel.getAiProviderModelList` / `file.getFiles` / `plugin.getPlugins` / `home.getSidebarAgentList`(401) + `message.getMessages`(400)。无 500。

## B. 裁决

**值得做。C 单独就能把「首个 tRPC 后回到 650」打掉；C+D 才是产品级。**

- G0b 的病：首个 `platform.getPublicSnapshot` 把整棵 lambda 静态图拉进来（+150 MB）。C 后 snapshot 只 +5 模块 / +0.5 MB chunk，RSS 停在 **~495**；11 条常见路由 burst 后再 **+34 MB → 528**，不再回到 650。
- D 关掉 `preloadEntriesOnStart`：boot chunk **76→12 MB**，boot RSS **500→274**。snapshot 才加载 lambda 入口（chunk 12→24 MB，RSS 274→373）。burst 几乎不再涨（375）。相对 G0b 会话后：**−280 MB**。
- 冷延迟：lazy 子路由 401 路径 **45–64 ms vs warm 39–40 ms**，可忽略。D 的 snapshot 首包贵 **~0.4 s**（lambda 入口不再预载），可接受；C 还比 G0b 更快（入口已预载、图更小）。
- 仍在 boot set：`discord.js=313`（instrumentation `gatewayService` 动态 import，与 router lazy 无关）、`sharp=14` / `client-s3=7`（`user`+`platform`/`admin`+branding worker 仍静态）。`xlsx` 随 `agentEval` lazy 离开 boot。
- **落地建议：** 全量 `lazy()`（可用已有 `moduleRouter`）+ Docker `preloadEntriesOnStart: false`。bots/sharp/S3 另开：gateway 跟 preset、branding barrel 拆 `assetStorage`、`user` 里 S3 改 `await import`。

## C. 运行时损坏

- 构建成功；`onNetworkProxySnapshotChange is not a function`（G0b 同款，page collect，非本次引入）。
- `aiCatalogReadiness failed to start { ReferenceError }`（G0b 同款）。
- burst 全部 200/401/400，**无 500**。`message.getMessages` 400 是缺 input，路由已加载。
- 类型未测（`ignoreBuildErrors`）。
