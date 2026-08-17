# 网络代理（Network Proxy）设计

> 2026-08-17 定稿。参照 [clash-party（mihomo-party）](https://github.com/mihomo-party-org/clash-party) 的订阅 / 节点 / 策略组体验，用 **mihomo 内核**做服务端出站代理，但只保留「订阅 + 多协议节点 + 出口选择」这一核心，其余桌面向功能全部裁掉；并加上 clash-party 没有的**按 AI 服务商 / 按网站功能的作用域开关**。
> 本文是实施前的设计基线；实施后以代码为准，并同步更新 `reference/` 下的表 / 权限 /tRPC 清单。

## 0. 一句话

服务端在**每一次出站 HTTP 请求前**按「作用域」（某个 AI 服务商，或某类网站功能：市场 / 联网搜索 / MCP / 导入拉取 / 内容审计端点）决定走直连还是走**全局唯一出口**；出口由后装的 mihomo 内核提供（订阅 → 节点 → 自动测速 / 手动指定 / 故障转移），或由一条免引擎的静态上游代理提供。引擎作为受监督的子进程跑在每个应用实例里，只监听 `127.0.0.1`；Node 侧用**按请求注入的 fetch /dispatcher** 路由，**绝不**改全局 dispatcher。管理面板「系统 → 通用设置 → 网络代理」Tab 提供 引擎（插件）/ 出口与节点 / 订阅 / 作用域 四块；一键开关全部服务商、全部功能。代理不可用时默认**对用户静默直连、对管理员显示错误**，可按作用域改为报错。

## 1. 与 clash-party 的对照（照搬 / 改进 / 放弃）

| clash-party                                          | 本设计                                                                                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内置多个内核版本、随 GUI 分发                        | **不内置**：固定一个 mihomo 版本（manifest 钉版本 + 逐架构 sha256），管理员在面板「自动下载」或「手动上传」；上传文件必须与 manifest 摘要一致                                                                        |
| 订阅（URL、更新间隔、UA、流量信息）                  | **照搬体验、改由 Node 拉取**：Node 经 SafeOutbound 定时拉取订阅（SSRF 防线与全站一致）写成 mihomo `file` provider（原生解析 Clash YAML 与 base64/URI 分享链接），流量 / 到期由 Node 直接解析 `subscription-userinfo` |
| 手动添加节点                                         | **照搬**：粘贴分享链接或 YAML 片段，落为 mihomo `file` provider                                                                                                                                                      |
| 策略组：select /url-test/fallback/load-balance       | **收敛为一个出口组 `AIHUB-OUT`**：自动测速 / 手动指定 / 故障转移 三种模式；不做 load-balance                                                                                                                         |
| 节点延迟测试、组测速                                 | **照搬**（走 mihomo REST）                                                                                                                                                                                           |
| 规则模式：rule /global/direct + 规则编辑             | **收敛为「简单 / 智能」两档**：简单 = 作用域内全走出口；智能 = 大陆域名 / IP 直连（需 geodata）。不提供规则编辑                                                                                                      |
| 全局生效（系统代理 / TUN）                           | **改进：按作用域生效**—— 每个 AI 服务商、每类网站功能独立开关，一键全开 / 全关；服务端自身依赖（DB/Redis/S3 / 内网）恒直连                                                                                           |
| DNS / TUN / 系统代理 / 覆写脚本 / Sub-Store / WebDAV | **放弃**                                                                                                                                                                                                             |
| 连接查看器、日志流                                   | **裁剪**：只保留引擎最近 200 行日志抽屉 + 每实例计数（走代理次数 / 直连兜底次数）                                                                                                                                    |
| 无失败策略                                           | **新增**：代理不可用时按作用域 `直连兜底 / 报错`，默认直连兜底并在管理端告警                                                                                                                                         |
| 桌面单机                                             | **多实例**：配置在库、引擎每实例一份、状态按实例上报                                                                                                                                                                 |

## 2. 术语与枚举

```ts
// 作用域：谁的出站流量
type EgressScopeKind = 'provider' | 'feature';
type EgressFeatureKey =
  | 'market' // 市场 / 发现 / 插件索引 / 助手店（market.lobehub.com、PLUGINS_INDEX_URL）
  | 'web_search' // 联网搜索服务商 + 网页抓取（jina/firecrawl/tavily/exa/browserless/naive…）
  | 'mcp' // 远程 MCP（HTTP/SSE）连接器；stdio 子进程 v1 不注入（见 3.5）
  | 'import_fetch' // 技能 / URL / GitHub 导入、图片视频 URL 下载、模型定价拉取（ssrfSafeFetch 消费方）
  | 'content_moderation'; // 内容审计的 Moderations 兼容端点（LLM 裁判跟随其服务商开关，不在此）
type EgressScopeId = `provider:${string}` | `feature:${EgressFeatureKey}`;

// 作用域状态
interface EgressScopeState {
  enabled: boolean; // 是否走出口
  onUnavailable: 'direct' | 'fail'; // 出口不可用时：静默直连（默认）/ 报错
}

// 出口
type OutletKind = 'engine' | 'static'; // mihomo 引擎 / 免引擎静态上游代理
type OutletMode = 'auto' | 'manual' | 'fallback'; // url-test / select / fallback
type RuleMode = 'simple' | 'smart';
type StaticProxyType = 'http' | 'https' | 'socks5';

// 引擎（每实例）
type EngineState =
  | 'unsupported' // 当前 OS/CPU 架构无对应产物
  | 'not_installed'
  | 'installing'
  | 'stopped' // 已安装但总开关关 / 出口为 static
  | 'starting'
  | 'running'
  | 'degraded' // 运行中但出口组内无存活节点
  | 'error'; // 反复崩溃 / 配置校验失败
type ArtifactKind = 'engine' | 'geoip' | 'geosite';
type ArtifactSource = 'download' | 'upload';

// 订阅
type SubscriptionKind = 'url' | 'manual';

// 运行时决策（热路径返回值）
type EgressDecision =
  | { mode: 'direct'; reason: 'master_off' | 'scope_off' | 'bypass' | 'fallback' }
  | { mode: 'proxy'; proxyUrl: string; outlet: OutletKind }
  | { mode: 'fail'; error: 'PLATFORM_NETWORK_PROXY_UNAVAILABLE' };
```

判定优先级：`总开关关 → 直连` > `目标在恒直连清单 → 直连` > `作用域未开 → 直连` > `出口可用 → 代理` > `onUnavailable`。

## 3. 架构与运行时流程

### 3.1 组件

```
┌ 管理面板 (通用设置 → 网络代理 Tab) ─── admin.networkProxy.* ─┐
│                                                                │
│  EngineArtifactManager   EngineSupervisor    SubscriptionSvc   │  每个应用实例一份
│  (下载/上传/校验/安装)  (spawn/健康/重启)   (CRUD/定时拉取/流量) │
│           │                    │  REST(127.0.0.1)              │
│           ▼                    ▼                                │
│   /app/.lobe/network-proxy/{engine,geodata,runtime}/    mihomo ── 出站
│                                                                │
│  EgressRouter (resolveEgress → fetch/dispatcher/curl)  ◄── 设置快照(库, revision 缓存, Redis 失效广播)
└──────────────────────────────────────────────────────────────┘
       ▲                ▲                 ▲              ▲
  ModelRuntime 桥   ssrfSafeFetch    功能 ALS 作用域   SafeOutbound 传输 / curl-impersonate
```

### 3.2 引擎交付（后装插件）

- **固定版本**：`scripts/networkProxy/manifest.json` 钉 mihomo 一个 release（首发取 `v1.19.30`，2026-08-16 发布），逐平台登记 `{ asset, gzSha256, binSha256, binSize }`：**只登记三个平台**：`linux/x64 → mihomo-linux-amd64-compatible`（GOAMD64=v1，覆盖无 AVX2 的老 CPU）、`linux/arm64 → mihomo-linux-arm64`、`darwin/arm64 → mihomo-darwin-arm64`（开发机）；armv7 /darwin x64 / Windows 一律不支持。改版本 = 改 manifest 一处 + 跑 `manifest.test.ts`（字段齐全、摘要格式、Dockerfile 无重复登记）；REST / 配置键 / JSON 形状只对这一版本负责，B2 必须为该版本写下 `now / alive / delay / updatedAt` 的契约测试（fixture 取自真实响应）。
- **两条安装路径，同一校验**：
  1. **自动下载**：`GET <base>/<version>/<asset>`；`base` 取 `NETWORK_PROXY_ENGINE_DOWNLOAD_BASE`，缺省按 `USE_CN_MIRROR` 在 GitHub Releases / `ghfast.top` 前缀间选（与 curl-impersonate 同款逻辑）。若已配置**静态出口**且勾选「通过静态代理下载」，下载本身经该代理（解决 "没代理就下不到代理" 的死锁）。
  2. **手动上传**：面板 Upload → `POST /webapi/admin/network-proxy/artifact`（multipart；接受 `.gz` 或裸二进制），见 §5 对该路由的鉴权栈要求。
  - **校验与落地（两条路径共用 `EngineArtifactManager.install(stream)`）**：流式解压，压缩体 ≤ 64 MiB、解压体 ≤ `manifest.binSize`（超出即中止，防 gzip 炸弹）；边写边算 sha256，`sha256(解压后二进制) === manifest.binSha256[平台]` 否则删除临时文件并报 `PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH`——**能被执行的只有 manifest 钉住的那一个构建**，上传接口不构成任意二进制执行面。临时文件用 `O_CREAT|O_EXCL|O_NOFOLLOW` 打开、fsync 后 `rename` 到不可变的版本化路径 `<dataDir>/engine/<version>/mihomo-<binSha256前16位>`，`chmod 0500`；目录 `0700`、拒绝符号链接与非常规文件（沿用 `identityProvider/lkg.ts` 的目录 / 权限校验）；**每次 spawn 前重新对将执行的 inode 做 sha256 校验**（≈40 MB，百毫秒级）后再执行，安装后跑一次 `mihomo -v` 记录输出。跨实例并发安装用同目录锁文件互斥。
  - `dataDir = NETWORK_PROXY_DATA_DIR ?? /app/.lobe/network-proxy`（`/app/.lobe` 是 enhanced compose 已挂载并 chown 给 `nextjs` 的命名卷；Dockerfile 本身没有 `VOLUME` 声明，**其它部署清单必须自行提供同样的挂载与属主**，demo compose 也要补挂）；开发机 `.cache/network-proxy/`。`NETWORK_PROXY_ENGINE_BIN` 可显式指向运维自带的二进制（跳过安装、仍做 `-v` 自检、**不**校验摘要，状态页明确标为「运维覆盖，未校验」）。
- **geodata（仅智能模式）**：`geoip.metadb`（`geodata-mode: false` 的默认 loader）与 `geosite.dat` 同样在 manifest 钉版本 + sha256（来源 `MetaCubeX/meta-rules-dat`），同一 `EngineArtifactManager` 下载 / 上传 / 校验，落到 mihomo 家目录（`runtimeDir/geoip.metadb`、`runtimeDir/geosite.dat`），`geo-auto-update: false`。面板一键 `installGeodata` 同时写入两种 desired 产物（单次 CAS + 一条 `network_proxy.geodata.install` 审计），本机再按 geoip → geosite 顺序下载；未请求这两种产物时服务端拒绝 `ruleMode: 'smart'`（`PLATFORM_NETWORK_PROXY_GEODATA_MISSING`）。未就绪时智能模式不可切换（Switch 置灰 + 说明）。
- **不支持的平台**（manifest 三个之外的一切，如 `linux/arm`(v7)、`linux/ia32`、`darwin/x64`、`win32`）：引擎状态 `unsupported`，页面提示只能使用「免引擎静态代理」。
- **多实例约束（v1 明示）**：安装是**实例本地**动作 —— 自动下载可由每个实例各自执行（`installArtifact` 经失效广播让所有在线实例各自下载）；**手动上传只落在接收请求的那个实例**（共享 `/app/.lobe` 卷时天然全体可见；未共享卷的多副本需逐实例上传或改用共享卷）。面板「实例」列表逐实例显示 已安装 / 版本 / 引擎状态 / 最近错误，只展示心跳新鲜（≤ 90 s）的实例。

### 3.3 引擎监督（`EngineSupervisor`，每进程一个）

- 启动条件：`masterEnabled && outlet.kind === 'engine' && 二进制就绪`；由 `apps/server/src/enterprise/routers/platform.ts` 的模块副作用 `ensureNetworkProxyEngineSupervisorStarted()` 注册，受 `isPersistentEnterpriseWorkerRuntime` 门禁（生产 + 非 edge + 非 serverless + 有 DATABASE\_URL）；测试 / 开发环境需显式 `NETWORK_PROXY_ENGINE_AUTOSTART=1`。
- 端口与凭据：在 `127.0.0.1` 上探测两个空闲端口 ——**mixed 监听**（HTTP+SOCKS5）与 **external-controller**；启动失败（端口被抢）自动换端口重试 3 次。每次启动生成随机 `authentication` 凭据（`aihub:<32B random>`）与随机 controller `secret`，同机其它进程无法借用出口或控制引擎。凭据必然写进生成的 YAML，因此 `config.yaml` 以 `0600` 创建、`runtimeDir` `0700`；凭据不进库、不进日志、不进 `getStatus`，所有出站 URL 经统一 `redactSecrets()`（剥离 userinfo /query token）后才允许进入日志、状态、错误消息、审计。
- 拉起：`spawn(bin, ['-d', runtimeDir, '-f', configPath], { env: 最小 env（PATH、HOME=runtimeDir、TZ、SSL_CERT_FILE）, stdio: pipe })`；stdout/stderr 经 `redactSecrets()` 进 200 行环形缓冲；`pid` 写 `runtime/mihomo.pid`，启动前若 pid 存活且 `/proc/<pid>/exe` 指向我们的引擎路径才 `SIGTERM` 清理（避免误杀 PID 复用的无关进程）。
- 健康：每 15 s `GET /version`（带 secret）；连续 3 次失败 → `SIGTERM` → 重启，退避 1s→2s→…→30s 封顶，10 分钟内崩溃 ≥ 5 次进入 `error`。监督器会按 `min(30s × 2^(n-1), 15min)` 自动自愈重试（不重置崩溃计数）；管理员「重启引擎」清零自愈状态。节点存活由 `GET /proxies/AIHUB-OUT` 的 `now` + 成员 `alive/history` 派生 `running | degraded`。智能分流缺规则数据时引擎仍以简单规则运行，并记下 `geodata_missing`（不是 `error`）。
- 配置变更：设置 / 订阅任何写入 → 重新生成 YAML → `PUT /configs?force=true` body `{ "path": "<configPath>" }`（热重载）；重载失败退化为重启。**期望态 / 实际态**：库里的 `revision` 是期望态，每个实例上报 `appliedRevision`（见 §4.3），面板据此显示「N 个实例已生效 / M 个落后」。多实例靠 `PlatformConfigInvalidationEvent`（Redis）广播 `network_proxy` scope，各实例收到后重读快照并热重载；「重启引擎」「自动安装」同样是广播语义（**所有**在线实例各自执行），v1 不做定向到某个实例的命令。
- 停机：进程 `SIGTERM/SIGINT/exit` 钩子先杀引擎再退出。容器停止时 PID 1 是 `startServer.js`（不转发信号），Next 进程与引擎会随容器命名空间一起被 kill；引擎无状态、不需要优雅退出，因此**不改动 launcher**。
- 资源：mihomo 常驻 RSS 约 30–80 MB（智能模式加载 geodata 再加～30 MB）；文档在 runbook 写明容器内存至少预留 128 MB 余量。

### 3.4 生成的 mihomo 配置（要点，非全文）

```yaml
mixed-port: <p> # 127.0.0.1 only
bind-address: 127.0.0.1
allow-lan: false
authentication: ['aihub:<random>']
external-controller: 127.0.0.1:<c>
secret: <random>
mode: rule
log-level: warning
unified-delay: true
tcp-concurrent: true
profile: { store-selected: false, store-fake-ip: false }
dns: { enable: false } # 简单模式用系统解析；智能模式 enable:true + nameserver 可配（默认系统 DNS）
geodata-mode: false # 智能模式：geoip.metadb + geosite.dat 已由 ArtifactManager 放进 runtimeDir；geo-auto-update: false
proxy-providers:
  sub_<id>: # 每条订阅（URL 或手动）一个 file provider；内容由 Node 侧拉取 / 解密后写入（见 3.5 订阅拉取）
    type: file
    path: providers/sub_<id>.txt # Clash YAML 或 分享链接 / base64，mihomo 原生两种都解析
    filter / exclude-filter: <可选正则>
    health-check: { enable: true, url: <latencyTestUrl>, interval: 300, lazy: false, timeout: 5000 }
proxy-groups:
  - name: AIHUB-OUT
    type: url-test | select | fallback # outlet.mode
    use: [sub_a, sub_b, ...]
    url: <latencyTestUrl>
    interval: <latencyIntervalSec>
    tolerance: <ms>
rules:
  # 到达引擎的流量本应全部是 Node 判定为「该走出口」的公网目标；凡解析到回环 / 私网 / 链路本地 / 元数据地址的一律 REJECT
  # （不是 DIRECT）——这既是 DNS 重绑定的兜底，也让 SafeOutbound 消费方在走代理时保住「解析后 IP 策略」这一层
  - IP-CIDR,169.254.169.254/32,REJECT
  - IP-CIDR,127.0.0.0/8,REJECT
  - IP-CIDR,10.0.0.0/8,REJECT
  - IP-CIDR,172.16.0.0/12,REJECT
  - IP-CIDR,192.168.0.0/16,REJECT
  - IP-CIDR,169.254.0.0/16,REJECT
  - IP-CIDR6,::1/128,REJECT
  - IP-CIDR6,fc00::/7,REJECT
  - IP-CIDR6,fe80::/10,REJECT
  - GEOSITE,cn,DIRECT # 仅智能模式
  - GEOIP,CN,DIRECT # 仅智能模式
  - MATCH,AIHUB-OUT
```

（上面的 IP-CIDR 规则**不加** `no-resolve`，让域名目标先解析再匹配。）订阅解析后的节点缓存由 mihomo 明文写在 `runtimeDir`（同任何 Clash 部署，含节点密码）；`dataDir` 目录权限 `0700`，属主 `nextjs`，运维备份应排除该目录，删除订阅时同步删除对应 provider 文件。手动模式的选中节点通过 `PUT /proxies/AIHUB-OUT {name}` 下发，并写回设置（`outlet.manualNodeName`），重启后重放。

### 3.5 Node 侧路由（`EgressRouter`）与订阅拉取

- **快照**：`platform_network_proxy_settings.config` + 引擎当前 `proxyUrl`（`http://aihub:<pw>@127.0.0.1:<p>`）+ 静态代理 URL，进程内按 revision 缓存，收到失效事件或 60 s 兜底重读。
- **`resolveEgress(scope: EgressScopeId, targetUrl: URL): EgressDecision`**——**每次请求、拿着真实目标 URL 才判定**（`createEgressFetch(scope)` 返回的 fetch 在每次调用时解析 `input` 后再决策，不在构造期冻结）：先做恒直连判断（loopback / RFC1918 / ULA / 链路本地 / `APP_URL` 自身 / `DATABASE_URL`、Redis、S3 endpoint、`SEARXNG_URL`、`OLLAMA_PROXY_URL` 主机 + 管理员 `bypassHosts`），再查作用域，再看出口健康；`onUnavailable: 'direct'` 时返回 `direct/fallback` 并给该实例的 `fallbackCount[scope]` +1、首次进入兜底时打一条 warn 日志；`'fail'` 时抛 `PLATFORM_NETWORK_PROXY_UNAVAILABLE`（用户侧显示为通用错误卡片，文案由 i18n `error.PLATFORM_NETWORK_PROXY_UNAVAILABLE` 提供）。重定向：走代理的请求所有跳都经代理（dispatcher 级），私网 / 元数据目标由引擎 REJECT 兜底；直连请求维持原有 SafeOutbound /ssrf 逐跳校验。
- **出口健康（引擎与静态出口同一套）**：`available = 引擎 running 且 AIHUB-OUT 有存活节点`（引擎）或 `静态代理探针正常`（静态）；两者都叠加一个**连接阶段熔断器**—— 通过出口的请求若在收到响应头之前因 `ECONNREFUSED / 407 / 代理握手超时 / TLS 到代理失败` 失败，计一次；60 s 内 ≥ 3 次则出口标记不可用 30 s（期间按 `onUnavailable` 处理），探针恢复后自动关闭熔断。**已发出请求体或已开始流式响应的请求绝不重放**，只把失败原样返回给调用方；直连兜底只发生在「决策时」。
- **三种落地形态**（都从同一个 decision 派生，绝不 `setGlobalDispatcher`）：
  1. `createEgressFetch(scope): typeof fetch` — undici `fetch` + 按 `proxyUrl` 记忆化的 undici `ProxyAgent`（http/https，凭据自动转成 `Proxy-Authorization`）或 undici `Socks5ProxyAgent`（socks5 静态出口；7.28 起内置、带 experimental 警告，若实测有问题回退到 `fetch-socks`）；dispatcher 缓存有上限、凭据 / 地址变化时旧 dispatcher `close()` 排空销毁；`direct` 返回原生 fetch。
  2. `curlProxyUrl(decision)` — 给 ChatGPT Web 的 curl-impersonate 传输层（`proxy = <url>` 指令；该传输层的错误消息中的 stderr 片段必须先经 `redactSecrets()`）。
  3. `buildEgressEnv(decision)`：`HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` — **v1 不使用**（服务端 `MCPService` 生产态 `allowStdio` 为 false，且把带凭据的引擎地址塞给用户选择的子进程等于泄露凭据）；`mcp` 作用域只覆盖远程 MCP（HTTP/SSE）。函数保留给桌面端 / 未来显式开启的场景。
- **接入缝（按探索结论）**：
  - **A. AI 服务商**：`apps/server/src/modules/ModelRuntime/index.ts` `initModelRuntimeWithUserPayload` — 双保险：①`customFetch = paramsFetch ?? chatgptWebTransport(proxyUrl) ?? createEgressFetch('provider:<id>')` 作为显式 `fetch` 参数传给 SDK（OpenAI/Anthropic 兼容工厂、Bedrock `createFetchRequestHandler`、AzureAI `createAzureFetchHttpClient`、AzureOpenAI、Google/Vertex 既有 `boundFetch`）；②**返回的 runtime 用与内容审计 `wrapModelRuntime` 同款的方法代理包一层，每个方法调用都在 `runWithBoundFetch(egressFetch, …)` 内执行**，这样各 provider 里绕过 SDK 直接 `fetch()` 的操作（OpenAI 兼容工厂的 `createVideo`、各家模型列表、token 交换、结果下载等）也被 ALS 垫片接住；fetch 本身在方法内同步发起，流式响应体后续消费不受 ALS 退出影响。补齐仍拿不到 fetch 的构造缺口：Ollama 转发 `fetch`（SDK 支持）、Cloudflare / ComfyUI / Replicate 接受 `fetch` 参数。ChatGPT Web：`getChatGPTWebFetch()` 单例改为按 `proxyUrl` 键控的工厂。**B3 必须交付一份覆盖清单测试**：静态扫描 `packages/model-runtime/src` 中所有裸 `fetch(` / SDK 客户端构造点，逐条标注「显式 fetch / ALS 覆盖 / 显式排除（原因）」，新出现的未标注调用点让测试失败。模型列表拉取、连通性检查、内容审计 LLM 裁判都经此桥，自动跟随该服务商开关。`fetchOnClient` 的 Ollama（浏览器直连）不受服务端代理影响，UI 需注明。**作用域 key = 运行时 provider id**（`runtimeProvider`，即内置服务商的 canonical key；平台目录里的自定义 OpenAI 兼容服务商用其目录 id）；用户私有自定义服务商 v1 不代理（未列出即关）。BYOK 与平台托管同桥、同开关。
  - **B. 网站功能**：`packages/ssrf-safe-fetch/index.ts` 只接受一个 `node-fetch` `agent`，无法与 `request-filtering-agent` 叠加 —— 因此改成：决策为 `direct` 时维持现状（过滤 agent），决策为 `proxy` 时换成 `https-proxy-agent` / `socks-proxy-agent` 并在换之前做主机名策略校验（`assertHostnamePolicy`），解析后 IP 的防线由 §3.4 的引擎 REJECT 规则承担；裸 `fetch` 的搜索 / 抓取实现、Market SDK、PluginStore、GitHub 模块用 **功能级 ALS 作用域** `runWithEgressScope('web_search' | 'market' | 'import_fetch', fn)` 在 tRPC 路由 / 服务边界包一层（复用 `boundFetch` 的全局 fetch 垫片机制，绑定的 fetch 由 decision 决定）；MCP：`MCPService({ httpFetch })` 已是注入点。B3 同样交付功能侧的调用点清单（每个 feature key 对应哪些文件）。
  - **C. 企业 `SafeOutboundHttpClient`（MCP 连接器、Moderations 端点）**：`transport/streamingTransport` 可注入 —— 决策为 `proxy` 时换成「主机名策略校验 → 经代理 `CONNECT`」的传输，**该请求放弃 Node 侧 DNS 钉定**，解析后 IP 的策略由引擎 REJECT 规则执行（这是有意的信任边界移交：走代理时以引擎的规则为准；`RESIDUAL.md` 登记此项）。`content_moderation` 作用域即通过这里到达 Moderations 端点。
- **与既有 `PROXY_URL`（proxychains 全进程 LD\_PRELOAD）互斥**：`PROXY_URL` 非空时整个进程已被全局代理，本模块的「直连 / 作用域关」都不再成立 —— 因此**拒绝开启**：`masterEnabled` 无法置为 true（服务端校验报 `PLATFORM_NETWORK_PROXY_GLOBAL_PROXY_ACTIVE`），面板顶部 banner 说明「已启用环境变量级全局代理，请二选一」。开发环境 better-auth 的 `EnvHttpProxyAgent` 全局 dispatcher（仅 `NODE_ENV=development` 且设置了代理 env）同理，文档提示开发时二选一。新 env 一律用 `NETWORK_PROXY_*` 前缀。
- **订阅拉取由 Node 负责（不用 mihomo 的 http provider）**：每条 URL 订阅在每个实例内按 `updateIntervalSec` 由 `startPersistentWorkerScheduler` 定时拉取 —— 通过 `SafeOutboundHttpClient`（主机名 + 解析后 IP 策略、≤ 8 MiB、10 s 超时、≤ 3 跳重定向、`User-Agent` 可配默认 `clash.meta`），可选「通过出口更新订阅」时改用 `createEgressFetch` 版本；响应体原样写入 `providers/sub_<id>.txt`（原子替换）并 `PUT /providers/proxies/sub_<id>` 触发引擎重读；`subscription-userinfo` 响应头直接由 Node 解析回写流量 / 到期（`UPDATE … WHERE last_update_at IS NULL OR last_update_at < $fetchedAt`，多实例幂等）。手动订阅（`kind=manual`）解密后写同名文件。这样订阅 URL 的 SSRF 防线与全站一致，也不依赖引擎的 provider JSON 形状。

### 3.6 出口不可用的判定与呈现

- 出口不可用 = §3.5 的 `available === false`（引擎未运行 / 无存活节点 / 静态探针失败 / 熔断中）。
- 用户侧：默认 `direct` 兜底 ——**不弹错、不降级提示**；管理端：状态徽标转红、banner 列出「正在直连兜底的作用域」及最近一次错误；`fail` 作用域的请求以 `PLATFORM_NETWORK_PROXY_UNAVAILABLE` 失败。
- 一键：「全部服务商 开 / 关」「全部功能 开 / 关」「全部兜底策略 直连 / 报错」三组快捷按钮，落为一次 `updateScopes` 批量写。

## 4. 数据模型

### 4.1 `platform_network_proxy_settings`（单行，`id='default'`，CAS `revision`）

```ts
interface NetworkProxyConfig {
  masterEnabled: boolean; // 总开关，默认 false
  outlet: {
    kind: OutletKind; // 默认 'engine'
    mode: OutletMode; // 默认 'auto'
    manualNodeName?: string; // manual 模式选中节点
    latencyTestUrl: string; // 默认 https://www.gstatic.com/generate_204
    latencyIntervalSec: number; // 默认 300
    toleranceMs: number; // 默认 150（url-test）
  };
  staticProxy?: {
    type: StaticProxyType;
    server: string;
    port: number;
    username?: string;
    passwordCiphertext?: string; // PlatformSecretService 信封加密
  };
  ruleMode: RuleMode; // 默认 'simple'
  bypassHosts: string[]; // 追加的恒直连域名 / 后缀 / CIDR
  subscriptionUpdateViaOutlet: boolean; // 默认 false
  downloadViaStaticProxy: boolean; // 自动下载引擎 / geodata 时是否经静态代理
  scopes: {
    providers: Record<string, EgressScopeState>; // key = provider id；未列出的服务商 = 关
    features: Record<EgressFeatureKey, EgressScopeState>;
  };
  engineLogLevel: 'silent' | 'error' | 'warning' | 'info';
}
```

其它列：`revision integer ≥ 0`、`updated_by`、`created_at/updated_at`；模型 `get / ensureDefault / update({config, expectedRevision, updatedBy})`（`SELECT … FOR UPDATE` + `PlatformRevisionConflictError`），照抄 `contentModerationSettings.ts`。

### 4.2 `platform_network_proxy_subscriptions`

| 列                                         | 说明                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `id` (`nps_…`)                             | idGenerator 前缀 `nps`                                               |
| `name`                                     | 展示名                                                               |
| `kind`                                     | `url` / `manual`                                                     |
| `url_ciphertext`                           | `kind=url`：订阅 URL 信封加密（URL 常含 token）                      |
| `url_host`                                 | 明文主机名，仅供列表展示 / 审计                                      |
| `payload_ciphertext`                       | `kind=manual`：分享链接列表或 YAML 片段，信封加密（含节点密码）      |
| `enabled`                                  | 是否纳入 `AIHUB-OUT`                                                 |
| `update_interval_sec`                      | 默认 86400                                                           |
| `user_agent`                               | 可选覆盖                                                             |
| `filter` / `exclude_filter`                | 可选正则（保存时用与内容审计相同的正则安全扫描，拒绝灾难性回溯模式） |
| `sort_order`                               | 列表顺序                                                             |
| `last_update_at` / `last_issue` / `last_error` | Node 拉取结果（成功时间 / `{ at, code, detail }` 结构化问题 / 本版保留、新写入不再使用） |
| `node_count`                               | 引擎 REST `GET /providers/proxies/sub_<id>` 回读                     |
| `traffic_upload/download/total/expire_at`  | Node 解析 `subscription-userinfo` 响应头，可空                       |
| `created_by` / `created_at` / `updated_at` |                                                                      |

回读字段由任一实例的拉取任务写回（`UPDATE … WHERE last_update_at IS NULL OR last_update_at < $fetchedAt`，幂等），不需要选主。

### 4.3 `platform_network_proxy_instance_status`（每实例一行）

`instance_id`（PK，FK → `platform_instance_heartbeats.id` ON DELETE CASCADE，随实例回收器一起清理）、`engine_state`、`engine_version`、`platform`、`arch`、`artifact_state jsonb`（engine/geoip/geosite 各自 installed/version/source，`source` 含 `operator_override` 表示 `NETWORK_PROXY_ENGINE_BIN` 未校验覆盖）、`applied_revision`（该实例已生效的设置 revision）、`active_node`、`alive_node_count`、`proxied_count`、`fallback_count`、`last_issue jsonb`（`{ at, code, detail }` 结构化问题，不再把原始英文异常当作面板正文）、`healing jsonb`（自愈中：`{ attempt, nextAttemptAt }`，仅 `error` 且已安排重试时非空）、`last_error`（本版保留、可空、新写入不再使用，供滚动升级期间旧进程读写；后续迁移再删）、`updated_at`。由各实例在状态变化与心跳时 upsert；面板「实例」列表 **join 心跳表、只展示 `last_heartbeat_at` 在 90 s 内的实例**（过期行仅作历史，不参与「已生效 / 落后」计数）。

### 4.4 不入库

引擎日志（进程内环形缓冲）、随机凭据与端口、节点延迟（实时问引擎）、mihomo 自己的 provider 缓存文件（`runtimeDir`）。

## 5. 权限、审计、注册表

- 权限码：`NETWORK_PROXY_READ = platform_network_proxy:read:all`、`NETWORK_PROXY_MANAGE = platform_network_proxy:manage:all`。角色：`super_admin` 自动全含；`auditor` 自动获得 read；`ai_admin` 等其它角色**不加**（改代理等于改全站出站路径，属平台级权限）。**现有部署需重播种**（bootstrap CLI，与内容审计同例）。
- 错误码：`PLATFORM_NETWORK_PROXY_UNAVAILABLE`（用户侧可见）、`PLATFORM_NETWORK_PROXY_ENGINE_NOT_INSTALLED`、`PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH`、`PLATFORM_NETWORK_PROXY_UNSUPPORTED_PLATFORM`、`PLATFORM_NETWORK_PROXY_ENGINE_ERROR`、`PLATFORM_NETWORK_PROXY_SUBSCRIPTION_INVALID`、`PLATFORM_NETWORK_PROXY_GLOBAL_PROXY_ACTIVE`（`PROXY_URL` 生效时拒绝开启）、`PLATFORM_NETWORK_PROXY_GEODATA_MISSING`（`ruleMode: 'smart'` 但尚未请求 geoip /geosite）。
- 审计动作（`network_proxy.*`，目标类型 `network_proxy_settings` / `network_proxy_subscription` / `network_proxy_engine`；en/zh 标签由 `auditLocaleCatalog.test.ts` 强制）：`settings.update`、`scopes.update`、`subscription.create/update/delete/refresh`、`engine.install`（含 source: download/upload、version、sha256）、`engine.restart`、`geodata.install`、`outlet.select_node`。写库变更与审计同事务；`afterDiff` 只放摘要（作用域开关数、订阅名与主机名），**永不含 URL / 节点 / 密码**；重认证被拒的危险操作也写审计（`assertDangerousReauthWithAudit`）。
- **危险操作与重认证**（`assertRecentReauth`，窗口内一次即可）：凡能改变全站出站去向的写操作都标 `dangerous` + 近期重认证 ——`updateSettings` 中改 `masterEnabled` / `outlet` / `staticProxy` / `ruleMode` / `bypassHosts`、`createSubscription` / `updateSubscription`、`installArtifact`、`installGeodata`、上传路由；`updateScopes`、`selectNode`、`refreshSubscription`、`testLatency`、`testConnectivity`、`restartEngine`、`deleteSubscription` 为常规写（`regularMutation` + 可选 reason）。
- 静态代理密码更新语义：`staticProxy.password: { action: 'keep' | 'replace' | 'clear', value? }`（读取只回 masked），避免 "可选字段 = 清空还是保留" 的歧义。
- tRPC `admin.networkProxy.*`（`preAccessAuthedProcedure` + `serverDatabase` + `withActiveUser` + `withAdminMutationRateLimit` + `withPlatformPermission`）：

| procedure             | 类型     | 权限   | 说明                                                                                                                        |
| --------------------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `getSettings`         | query    | READ   | 配置 + revision（静态代理密码只回 masked）                                                                                  |
| `getStatus`           | query    | READ   | 出口摘要（可用性 / 熔断 / 当前节点 / 延迟）+ 每个新鲜实例的引擎状态与 `appliedRevision` + 兜底中的作用域 + `PROXY_URL` 检测 |
| `listSubscriptions`   | query    | READ   | 列表（URL 只回主机名）                                                                                                      |
| `listNodes`           | query    | READ   | 从**应答本请求的实例**的引擎 REST 读 `AIHUB-OUT` 成员：名称 / 类型 / 来源订阅 / 延迟 / 存活；响应带 `instanceId`            |
| `getEngineLogs`       | query    | READ   | 应答实例最近 200 行（已脱敏），响应带 `instanceId`                                                                          |
| `getArtifactStatus`   | query    | READ   | manifest 钉住的版本 / 平台支持 / 各新鲜实例安装情况                                                                         |
| `updateSettings`      | mutation | MANAGE | CAS；含总开关 / 出口 / 分流模式 /bypass/ 静态代理；`dangerous` + 重认证                                                     |
| `updateScopes`        | mutation | MANAGE | 批量：单个 / 全部服务商 / 全部功能 的 enabled、onUnavailable；CAS                                                           |
| `createSubscription`  | mutation | MANAGE | URL 主机名过 `assertHostnamePolicy`（元数据地址阻断）；`safeOutbound` 控制；`dangerous` + 重认证                            |
| `updateSubscription`  | mutation | MANAGE | 同上                                                                                                                        |
| `deleteSubscription`  | mutation | MANAGE | 确认弹窗；`reason` 可选；同步删除各实例的 provider 文件（经失效广播）                                                       |
| `refreshSubscription` | mutation | MANAGE | 立即拉取一次（本实例执行并写回；其它实例经广播各自拉取）                                                                    |
| `testLatency`         | mutation | MANAGE | 组测速 `GET /group/AIHUB-OUT/delay?url&timeout`（对全部成员）或单节点 `GET /proxies/<name>/delay`；在应答实例执行           |
| `selectNode`          | mutation | MANAGE | manual 模式选中节点（写设置 + 各实例经广播下发引擎）                                                                        |
| `installArtifact`     | mutation | MANAGE | `{kind, source:'download'}`；广播语义（所有在线实例各自下载安装）；`dangerous` + 重认证                                     |
| `installGeodata`      | mutation | MANAGE | 一键写入 geoip + geosite desired 态（单次 CAS）后本机顺序下载；`dangerous` + 重认证；`local` 为两路结果的聚合               |
| `restartEngine`       | mutation | MANAGE | 清零崩溃计数并重启（广播语义，所有在线实例）                                                                                |
| `testConnectivity`    | mutation | MANAGE | 经当前出口 `GET latencyTestUrl`，返回耗时 / 出口 IP（可选，用 `https://api.ip.sb/ip` 类端点，可配）                         |

- **上传路由 `POST /webapi/admin/network-proxy/artifact`**（multipart 不走 tRPC）：仓库现无 admin webapi 的鉴权栈与注册表，需要**新增一个可复用的守卫** `withAdminWebapiGuard({ permission, reauth: true, rateLimit: 'admin-mutation' })`：`checkAuth` 认证 → `withActiveUser` 等价校验 → `withPlatformPermission(NETWORK_PROXY_MANAGE)` → `assertRecentReauth` → 管理端速率限制 → 成功 / 失败都写审计（`network_proxy.engine.install`，source=upload）；并新增一份极小的 `adminWebapiRouteRegistry`（路径 → 权限 / 危险级 / 控制项）与测试（扫描 `src/app/(backend)/webapi/admin/**` 目录，每个 route 都必须登记）。这是本设计唯一新增的横切基础设施；后续管理端文件类接口复用它。
- 注册表计数：`197/95/102 → 214/101/113`（6 query + 11 mutation；以实现为准，测试注释追加变更行）。

## 6. 管理面板

- 位置：`/admin/system/general?tab=network-proxy`。「通用设置」改为 `AdminPageTemplate` + `Tabs`（`@lobehub/ui/base-ui`）：**基础设施**（现有三张卡）| **网络代理**；`?tab=` 方案照抄内容审计页；侧栏不新增菜单项。图标沿用系统组。
- Tab 内自上而下四段（每段一张卡 / 一个 `DataTable`），顶部一行：**主操作只有一个 —— 总开关 `Switch`**；其后是状态徽标（引擎 / 出口 / 当前节点 + 延迟 / 已生效实例 N/M）与一个次级「更多操作」下拉（`DropdownMenu`：全部服务商 开・关 / 全部功能 开・关 / 全部兜底策略 直连・报错 / 组测速 / 重启引擎）。所有失败态用 banner 说明「影响什么、怎么修」，遵循 DESIGN.md 的确定性原则与「一个主操作」约定。
  1. **引擎（插件）**：钉住的版本与平台、本实例状态、安装来源（含「运维覆盖，未校验」态）；按钮「自动下载安装」「上传文件」（Upload，接受 `.gz`/ 裸文件，显示期望 sha256 前 12 位供人工核对，上传中显示进度、完成后显示校验结果）「重新安装」；实例表（实例 / 状态 / 版本 / 已生效 revision / 最近错误 / 更新时间，只列新鲜实例）；「日志」抽屉（标明来自哪个实例）；智能模式下多一行 geodata 状态与同样的安装按钮。安装 / 重启 / 刷新等长任务都有 进行中 → 成功 / 失败（可重试）三态，不只 toast。
  2. **出口与节点**：出口类型（引擎 / 静态代理；静态代理表单 = 类型 / 服务器 / 端口 / 认证，布局参考桌面端 `ProxyForm` 的分组 —— 只借鉴布局与校验规则，组件不复用）、模式（自动测速 / 手动指定 / 故障转移）、测速 URL / 间隔、分流模式（简单 / 智能，geodata 未就绪则智能置灰）、恒直连例外（tags 输入）、「测试连通性」；节点表 `DataTable`（名称 / 类型 / 来源 / 延迟 / 存活，列头筛选；手动模式下行首单选；行内「测速」；表头注明数据来自哪个实例）。
  3. **订阅**：`DataTable`（名称 / 类型 / 节点数 / 已用・总量・到期 / 更新间隔 / 上次更新 / 状态 / 操作），新增走 `createModal` 向导（URL 订阅 or 手动节点粘贴），编辑抽屉，立即更新，删除 `confirmModal`；URL 一律脱敏为主机名。
  4. **作用域**：两张表 ——**AI 服务商**（平台目录里已启用的服务商 + 内置服务商列表，图标 / 名称 / 开关 / 不可用时（直连・报错）/ 备注：`fetchOnClient` 的 Ollama 标「浏览器直连，不受影响」）与**网站功能**（5 项，同列）；表头一键全开 / 全关；每次改动即时保存（无草稿）。**保存失败 /revision 冲突**：保留用户刚改的值、拉取最新 revision、行内提示冲突并提供「重试」，不静默回滚。
- 用户端：不新增 UI；仅 `fail` 策略下出现通用错误卡片。

## 7. 实施批次（每批一 commit，grok 编码 /opus5 前端 /codex 复审）

| 批次 | 内容                                                                                                                                                                                                                                                                             | 主要文件                                                                                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0   | 我手写：常量 / 类型 / 权限码 / 错误码 /manifest（含 sha256、binSize）/ 接口契约文档 `B0_INTERFACE.md`                                                                                                                                                                            | `packages/const/src/platform/networkProxy.ts`、`permissions.ts`、`roles.ts`、`errorCodes.ts`、`packages/types/src/platform/networkProxy.ts`、`scripts/networkProxy/manifest.json`                                                                               |
| B1   | 数据层：三张表 + 模型（CAS）+ 迁移 `0017`（`when` 1787200000000）+ 秘密加解密助手 + 设置快照 / 失效广播 + `redactSecrets()`                                                                                                                                                      | `packages/database/src/schemas/platform/networkProxy.ts`、`models/platform/networkProxy*.ts`、`migrations/0017_*`、`apps/server/src/enterprise/services/networkProxy/{settings,secrets,redact}.ts`                                                              |
| B2   | 引擎层：`EngineArtifactManager`（下载 / 上传流校验 / 安装 /geodata/spawn 前重校验）、`EngineSupervisor`（spawn / 健康 / 重启 / 端口与凭据 /pid 校验）、YAML 生成器、REST 客户端（v1.19.30 契约测试）、订阅拉取调度、实例状态上报、开发机安装脚本 `bun run network-proxy:install` | `apps/server/src/enterprise/services/networkProxy/{artifacts,supervisor,configGenerator,restClient,subscriptionFetcher,instanceStatus}.ts`、`scripts/networkProxy/install.mts`                                                                                  |
| B3   | 路由层：`EgressRouter`（逐请求判定 / 熔断 /dispatcher 缓存）+ 接入缝 A/B/C（ModelRuntime 桥 + 方法级 ALS 包装、provider 缺口、ChatGPT Web 工厂、ssrfSafeFetch 代理 agent、功能 ALS 作用域、MCP httpFetch、SafeOutbound 传输）+ 恒直连清单 + 计数 + **调用点覆盖清单测试**        | `apps/server/src/enterprise/services/networkProxy/egress/*`、`apps/server/src/modules/ModelRuntime/index.ts`、`packages/ssrf-safe-fetch/index.ts`、`packages/model-runtime/src/providers/{ollama,cloudflare,comfyui,replicate}`、`apps/server/src/services/mcp` |
| B4   | 管理路由：契约 + `admin.networkProxy.*` + 上传 webapi（`withAdminWebapiGuard` + `adminWebapiRouteRegistry`）+ 两个注册表 + 审计目录 + 计数                                                                                                                                       | `apps/server/src/enterprise/{contracts,routers/admin}/networkProxy*.ts`、`src/app/(backend)/webapi/admin/network-proxy/artifact/route.ts`、`security/policy/*/entries.platform.ts`、`services/audit/auditActionCatalog.ts`                                      |
| B5   | 前端：通用设置改 Tab、网络代理四段 UI、i18n（admin.ts en/zh + 审计标签 + 错误码）、Playwright 冒烟                                                                                                                                                                               | `src/enterprise/client/features/admin/systemGeneral/*`、`.../networkProxy/*`、`packages/locales/src/default/admin.ts`、`error.ts`                                                                                                                               |
| B6   | 收口：reference 四份清单、README 文档地图、compose/`.env.example`/Dockerfile ENV、runbook（引擎故障处置 / 内存余量 / 备份排除）、demo 上线（重播种权限、demo compose 挂 `/app/.lobe`、真机上传引擎 + 订阅 e2e）                                                                  | `docs/enterprise/**`、`docker-compose/enhanced/docker-compose.yml`、`Dockerfile`                                                                                                                                                                                |

验证矩阵（B2/B3 单测之外）：假代理集成测试（本地 HTTP 代理 + SOCKS5 代理，覆盖认证 / 重定向 / 流式 / 连接阶段失败熔断 / 兜底计数）；恶意产物测试（gzip 炸弹、摘要不符、符号链接、超大解压）；镜像冒烟（amd64 与 arm64 的 scratch 镜像内 `spawn mihomo -v`）；demo 真机：上传引擎 → 加订阅 → 组测速 → 开某服务商 → 对话经代理（引擎日志可见连接）→ 停引擎观察静默直连 + 管理端告警。

并行规则同内容审计：B1/B2/B3/B4 同树并行，靠 `B0_INTERFACE.md` 提前约定契约与文件集互斥；B5 依赖 B4 契约。每批 `bun run check` 全绿 + codex 复审通过后 commit；全部完成后 `push` + 构建 `aihub:demo`。

## 8. 明确不做（本期）

- 内置引擎到镜像、多内核版本并存、自动升级内核；外部 /sidecar 引擎（env 指向已有 mihomo）；Windows 服务端。
- 按作用域指定不同出口（多监听端口）、load-balance 组、规则编辑器、覆写脚本、Sub-Store、WebDAV 备份。
- TUN / 系统代理 / DNS 面板 / 连接查看器 / 实时日志流 / 流量图表；UDP 转发。
- 定向到单个实例的命令（重启 / 安装 / 节点查询）与持久化命令队列；上传产物的跨实例分发（共享卷或逐实例上传解决）。
- MCP stdio 子进程 / 异构 Agent 子进程的代理 env 注入（会把引擎凭据交给用户选择的可执行文件）。
- 用户端（浏览器）直连的请求（`fetchOnClient` Ollama、桌面客户端自身代理）—— 桌面端保留其现有代理设置。
- 用户私有自定义服务商的代理开关（管理端无法枚举；未列出即关）。
- 订阅内容的服务端二次转换（交给 mihomo 原生解析；不支持的格式在订阅状态里报错）。
- 代理请求的逐条访问日志与配额；只保留每实例计数。

## 9. 设计复审吸收记录（codex gpt-5.6-sol，2026-08-17）

吸收（已改入正文）：SafeOutbound /ssrfSafeFetch 走代理时丢失解析后 IP 策略 → 引擎规则改 REJECT 兜底 + 明示信任边界；`node-fetch` 单 agent 不能叠加 → 分支实现；ModelRuntime 桥外的裸 fetch → 方法级 ALS 包装 + 覆盖清单测试；决策必须逐请求带目标 URL；静态出口 "恒可用" → 探针 + 连接阶段熔断、绝不重放；上传只落本实例 → 明示约束；凭据必然入 YAML → `0600` + 统一脱敏；上传加固（流式解压上限、`O_EXCL|O_NOFOLLOW`、`0500`、spawn 前重校验、运维覆盖显式标记）；订阅改由 Node 经 SafeOutbound 拉取；webapi 上传路由需要独立守卫 + 注册表；改出站去向的写操作一律重认证；`PROXY_URL` 生效时拒绝开启；`PUT /configs` 需 body；`geodata-mode` 与产物对应关系；实例新鲜度 90 s；密码 keep/replace/clear；dispatcher 缓存有界并回收；UI 一个主操作 / 长任务三态 / 冲突不静默回滚；验证矩阵。

未吸收（判断为过度设计或与产品决策冲突）：跨实例共享产物存储与「期望版本拉取」流水线（用户已选本地卷）；持久化定向命令队列 + fencing（v1 广播语义足够，见 §8）；改造 `startServer.js` 为信号转发 / 子进程收割的 init（容器停止会连带杀死全部进程，引擎无状态）；`nlink` / 属主逐项校验等超出 lkg.ts 既有强度的文件校验；每个 provider 操作各写契约测试（以覆盖清单测试 + 假代理集成测试替代）；PID 复用问题用进程启动身份比对（用 `/proc/<pid>/exe` 路径比对即可）；`/group/<name>/delay` 改为 `/proxies/<name>/delay`（前者是 mihomo 组测速端点，正文两者并列说明）。

## 10. 实施落地备注（2026-08-17）

B1–B5 五个 commit 已上线，以下是**实现与本设计正文不一致或正文未写死**的点，以代码为准：

- **引擎清单是 TS 常量**：`NETWORK_PROXY_ENGINE_MANIFEST`（`packages/const/src/platform/networkProxy.ts`），不是 `scripts/networkProxy/manifest.json`；`bun run network-proxy:install` 直接 import 该常量。
- **runtimeDir 按实例隔离**：`<dataDir>/runtime/<instanceId>`（`config.yaml` / pid / providers），`engine/` 与 `geodata/` 仍共享。启动只重建自己那棵；兄弟目录**不做 PID 探活**（共享卷上的副本处于不同 PID 命名空间，探活会误删活实例），仅在目录 mtime 超 7 天时回收。
- **上传路由先预检 `Content-Length`**：缺失或 `Transfer-Encoding: chunked` → 411，`Content-Length` 超 64 MiB + 64 KiB → 413，两者都在读 body 之前；通过后才用 `request.formData()`（文件上限 64 MiB），没有引入流式 multipart 解析器。`?kind=` 非法时审计里记闭合值 `invalid`，原始参数不落库。
- **订阅由 Node 经 SafeOutbound 拉取**（不交给引擎）：手动 `redirect: 'manual'`、≤ 3 跳、逐跳主机策略 + 元数据地址拒绝；出口不可用时降级直连，并在 `last_error` 注明 `outlet unavailable, fetched direct`。
- **变更注册表 `noReason`**：`createSubscription` / `updateSubscription` / `installArtifact` 的 DTO 没有 `reason` 字段，登记为 `noReason`；为此把 `DangerousAdminMutationDefinition.reason` 放宽到 `AdminMutationControl`（危险操作允许 `not-applicable`），并在 `adminMutationRegistry.test.ts` 把这三条钉成唯一白名单，其余危险 mutation 仍必须有 reason。
- **`local` 结果字段**：`installArtifact` / `restartEngine` / `selectNode` 在写期望态之外还会**本机立即执行**，响应带 `local: { ok, error }`。DB 写已提交，`local.ok === false` 只代表本实例这一次没成功（前端按长任务错误态展示，不当成静默成功）；本机结果另写一条 post-commit 审计，该审计插入失败只记日志，不把已提交的写变成 500。
- **注册表计数**：授权注册表 `197/95/102 → 214/101/113`（网络代理 +6 query / +11 mutation）；另有批次并行加了 1 个 mutation，**实际数字以 `adminProcedureAuthorizationRegistry.test.ts` 为准**。webapi 上传路由登记在新增的 `adminWebapiRouteRegistry.ts`（目录扫描测试逐一对账）。
- **§8「不做」项的落地形态**：MCP **stdio** 子进程不注入代理 env（HTTP 型 MCP 已接入，`httpFetch = createEgressFetch`，fail 模式贯穿为 `PLATFORM_NETWORK_PROXY_UNAVAILABLE`）；用户私有自定义服务商的作用域一律关闭 —— 作用域 key 取目录 provider id，未列出的私有 id 走 `scope_off` 直连。
- **重定向链只认首跳出口**：`ssrfSafeFetch` 走代理时，首跳选定的代理贯穿整条重定向链，后续跳只再校主机 / 元数据策略，不会中途切直连（避免半程改变信任边界）。
- **静态出口健康**：从 `unknown` 起步，启动与快照变更各探一次、之后每 60 s 一次；熔断只统计**代理连接阶段**失败（407 计失败；目标证书过期 / 目标 DNS 失败不计）。
- **摘要不符可由管理员显式接受（仅上传路径）**（2026-08-17 追加）：管理端在上传前用 WebCrypto 算 sha256（gzip 资产比对 `gzSha256`，裸文件比对 `binSha256` / 规则文件 sha256），不一致时弹警告，管理员可取消或「仍然安装」；后者以 `?acceptMismatch=1` 上传，服务端把实际摘要写入产物旁的 `<file>.accepted` 侧文件（`0400`，`O_EXCL|O_NOFOLLOW`），`verifyPinnedFile` 在 manifest 摘要不符时读取该侧文件、相等才放行；`artifactState.pinnedDigestMatch=false` 与审计 `afterDiff.pinnedDigestMatch=false` 记录该状态，面板标注「校验值与官方发布不一致，已由管理员确认安装」；自动下载路径永不接受不符（`acceptMismatch` 对 `source=download` 无效），匹配文件重新落地时删除侧文件。面板「引擎」区改为左（版本 / 平台 / 当前实例引擎状态）右（依赖面板：每个依赖一行，标题旁小字 SHA-256、状态、「下载文件」直达官方 URL、「上传文件」已安装即置灰、「安装 / 重新安装」，顶部「一键安装」装齐所有缺失项）分栏，实例表在下方通栏。
- **spawn 前重校验有身份缓存**：每次 `startEngine` 都重新校验产物 sha256，但状态 /reconcile/ 上报路径按 `(dev, ino, size, mtime)` 缓存，不会在热路径上重算～50 MB。
- **可观测性缺口**：`ENTERPRISE_CACHE_DOMAINS` 还没有 `network_proxy` 成员，设置快照缓存目前靠 cast，指标里会归为 unknown。
- **i18n 未补齐**：`admin` 命名空间的 264 个 `networkProxy.*` 键（外加 `enterprise.error.PLATFORM_NETWORK_PROXY_*`）只手写了 en-US /zh-CN，其余 14 语言的 `bun run i18n` **未运行**，这些语言下回退英文。
- **已部署实例需重播种 RBAC**：`NETWORK_PROXY_READ` / `NETWORK_PROXY_MANAGE` 是新权限，老实例的 `super_admin` 角色包里没有，必须跑一次 bootstrap CLI 重播种，否则连超管都看不到网络代理 Tab。
- **验收缺口**：设计 §7 列的 Playwright 冒烟未写（只有 Vitest + RTL 覆盖）；真机验收（上传引擎 → 加订阅 → 组测速 → 对话经代理）与 compose/`.env.example`/runbook 仍属 B6 收口，尚未完成。
