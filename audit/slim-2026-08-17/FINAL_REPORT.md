# LobeHub Enhanced 部署减负 / 可选模块 — 交付报告（2026-08-17）

## 1. 你拿到了什么
- **模块开关体系**：24 个可关模块（上游 11 + 企业 13），三档预设 `LOBE_MODULE_PRESET=minimal|standard|full`（默认 full = 今天）+ `LOBE_MODULES_DISABLED=a,b`；管理后台 **系统 → 模块** 页可自定义（预设只是起点），每模块带性能标签（常驻内存 / 后台任务数 / 每条消息·每次请求·每次出站 / 子进程 / 负载敏感 / 配套依赖）与汇总条，保存 CAS 防覆盖，关审计/内容审计需确认+重认证，需重启的模块出横幅「立即重启」（supervisor 模式自重启），首次进入有三步引导态。
- **优雅降级**：关掉的模块菜单隐藏；直链显示「模块未启用」并指出原因（环境变量名 / 去模块页开）；tRPC 返回 `PLATFORM_MODULE_DISABLED`（FORBIDDEN，非 404）；用户端上游功能靠派生的 FEATURE_FLAGS 隐藏；用户端 `platform.*` 目录读保持"稳定空目录"。
- **服务端减负**：11 个企业后台 worker 改为模块感知的注册表启动（不再是 router 导入副作用）+ 空转指数退避（3 次空转后翻倍到 60s）；机器人网关 / 内容审计包装 / 代理 egress 绑定 / mihomo 监督按 boot 视图门禁；**全部 lambda/async/tools/mobile 子路由 tRPC lazy()**（除 admin/platform/healthcheck/config/user）+ Docker `preloadEntriesOnStart:false`；sharp / S3 客户端 / xlsx / 11 个搜索 provider / 机器人适配器按需加载。
- **热路径**：globalConfig 服务商配置 memo、用户活跃校验 5s epoch 缓存、每请求一次 RBAC join、loadModels memo、公开快照 8s 缓存、AI 目录快照/校验和 memo（失败 fail-closed）、Redis scope-version 并发合并、egress 4 字段投影不再 clone 解密 YAML、内容审计单次快照 + 正则规则按 digest 只发一次、每次 execAgent 设置读去重。
- **Docker/部署**：镜像 1.72GB → **1.1GB**（去掉 270MB Vite 中间产物、桌面/CLI/e2e/tests；`/app/src` 43MB 根因是 network-proxy 引擎里 `path.resolve(process.cwd(), <import 常量>)` 触发全仓 trace，改字面量后 80KB）；启动器新增 `SKIP_DB_MIGRATION` / `ENABLE_BOT_GATEWAY` / `LOBE_NODE_HEAP_MB`（仅显式设置才注入堆上限，enhanced compose 默认 1536）；compose 新增 `docker-compose.minimal.yml`（app+ParadeDB）与 searxng profile（`search`），旧 `.env` 用户零变化；文档 `docs/enterprise/modules.md`。
- **首屏**：i18n 按命名空间/语言拆 chunk（不再首屏下载 ar）、LazyDiff、管理端/重依赖 chunk 不再预载、计时器守卫、SWR 2s 去重：阻塞首屏 JS 31.4→22.4MB（运行时全部 JS 33.8→25.5MB）。

## 2. 实测（参考构建 arm64；V1 真机三档见 reports/V1.md）
| 指标 | 之前 | 之后 |
|---|---|---|
| next-server 空闲 CPU | ~1.5%（11 worker 2–5s 轮询，2.3 xact/s） | 中位 0%（峰值仅 GC），0.3–0.9 xact/s |
| 启动 RSS（full） | ~500MB | **271MB**（standard 236 / minimal 214） |
| 典型会话后 RSS | ~650MB | 340–430MB |
| 镜像 | 1.72GB | 1.1GB |
| 首屏 JS | 33.8MB / 423 文件 | 25.5MB / 242 文件（阻塞部分 22.4MB） |
| 懒路由冷延迟 | — | +20–60ms 一次；首个请求 +~0.4s |
每模块常驻内存（all-lazy 构建下实测）：bots 22MB、networkProxy 8MB（+ mihomo 子进程 ≈43MB 装引擎后）、managedAi 6、branding 6，其余空闲 ≈0（按需加载）——已写进常量表与页面。

## 3. 上游友好度
上游文件只做一行守卫 / 一行替换 / 一层 memo / `await import()`：`src/instrumentation.ts`（boot 顺序 + 网关守卫）、四个 root router（每键一行 lazy/moduleRouter）、`featureFlags/index.ts`（一行包装）、`globalConfig/index.ts`（memo + 一字段）、`packages/trpc` context（3 处一行换缓存版）+ async errorFormatter、`agent-hono/index.ts` / workflows 路由（一行 gate）、`DeferredStoreInitialization.tsx`（一行）、`next.config.ts`（docker 分支两项）、`startServer.js`（3 个 if）、`define-config.ts`（删 2 行错误 include）、`src/libs/swr`（默认值）、vite 分包配置、`serverConfig.ts` 一字段。其余全部在 fork 目录。

## 4. 未做 / 二期候选
- ParadeDB → 普通 PG（用户已定不动）；heteroAgents 模块化（需先解环）；`platform_jobs` 合并 dispatcher / LISTEN-NOTIFY；Rust/C++（本轮无计算密集热点；候选：内容审计正则/Aho-Corasick）；首屏 7.4MB `es-*` 共享块（@lobehub/icons SVG + elkjs + parse5）需单独一轮；`/api/v1` OpenAPI 未门禁（核心）；deviceGateway 只做 UI + 工具运行时门禁（`lambda.device` 与桌面设备注册混用）。
- 存量失败（main 同样红，与本批无关）：`platform.mount.regression` getCapabilities（fake db 无 select）、`serverRuntimes/__tests__/memory.test.ts`（schemas mock 缺 topics）、`packages/const layoutTokens.test`（describe 未定义）。

## 5. 产物
分支 `feat/slim-modules`（10 commit，已 rebase 到 main c2b21ae32a）；镜像 `aihub:slim-final3`；scratchpad `slim/`：PLAN.md、explore/E1–E5 + G0/G0b/G0c/G0d、reports/G1–G5/F1/F2/V1/V2、reviews/、prompts/。
