# ChatGPT Web 服务商运维手册

> 2026-08-15 制定，对应 `ae772f2b84..2ca058c20a`。
> 服务商 id `chatgptweb`、显示名 **ChatGPT Web**，直连 `chatgpt.com` 的网页端私有协议（非 OpenAI Platform API），因此它比其他服务商多一个**运维前置条件**：服务端必须能运行 `curl-impersonate` 二进制。
> 本文只描述当前代码的真实行为；协议细节以 `packages/model-runtime/src/providers/chatgptWeb/` 为准。

## 0. 为什么需要一个额外的二进制

`chatgpt.com` 与 `chatgpt.com/backend-api/*` 在 Cloudflare bot-fight 之后，校验的是 **TLS / HTTP2 指纹**而不是请求头：Node 自带的 `fetch` 无论带什么 header、带不带 `Authorization`，都会拿到 `403` + `cf-mitigated: challenge`。所以服务端用 [`lexiforest/curl-impersonate`](https://github.com/lexiforest/curl-impersonate) 起子进程发请求，浏览器画像固定为 **`chrome136`**（实测 `chrome145` 会被挑战；UA 也同步钉在 Chrome 136 / Windows，不要只改一边）。

- 传输层代码：`apps/server/src/enterprise/services/chatgptWeb/transport/`（仅服务端；`packages/model-runtime` 必须保持同构，运行时通过构造参数注入 `fetch`）。
- 注入点：`apps/server/src/modules/ModelRuntime/index.ts`（用户路径）、企业 `runtimeAdapter.ts`（平台托管路径）、`connectionTestService.ts`（管理端连通性检查）。
- OAuth 令牌端点（`auth.openai.com`）用普通 `fetch` 即可，不走该传输层。

## 1. 环境变量

| 变量                               | 默认值 | 说明                                                                                                                                                         |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHATGPT_WEB_CURL_IMPERSONATE_BIN` | 空     | `curl-impersonate` 可执行文件的**绝对路径**。显式指定时若不可执行，直接报错（不再继续探测）。                                                                |
| `CHATGPT_WEB_ALLOWED_HOSTS`        | 空     | 追加到传输层主机白名单的**域名后缀**，英文逗号分隔。内置白名单恒生效。                                                                                       |
| `CHATGPT_WEB_ALLOW_INSECURE_HTTP`  | `0`    | 置 `1` 允许该传输层走明文 `http`。**仅供测试 / 本地 mock 后端**，生产不要开。                                                                                |
| `PROXY_URL` / `HTTPS_PROXY`        | 空     | 复用既有出网代理变量，作为 `curl -x` 传入（也识别小写 `https_proxy`）。带 `user:password@` 的代理串只写进子进程 stdin 的 config，不会出现在 argv / `ps` 里。 |
| `SSL_CERT_FILE`                    | 空     | CA bundle，作为 `--cacert` 传入；未设置时回落 `NODE_EXTRA_CA_CERTS`。静态 musl 版 curl 自带的证书路径可能与宿主不同，内网 TLS 拦截场景需要显式指定。         |

`.env.example` 的 `AI Provider Service` 段落已列出前三个（`## ChatGPT Web ###`）。

### 1.1 二进制解析顺序

`resolveCurlImpersonateBinary()`（`transport/resolveBinary.ts`）按顺序取第一个**可执行**的：

1. 代码显式传入的 `binaryPath`（仅测试 / 特殊调用方使用）；
2. `CHATGPT_WEB_CURL_IMPERSONATE_BIN`；
3. `PATH` 中的 `curl-impersonate`；
4. 仓库内 `./.cache/curl-impersonate/curl-impersonate`（开发机，见 §2）；
5. `/usr/local/bin/curl-impersonate`（Docker 镜像内置位置）。

结果在进程内缓存（二进制位置不会在运行期改变）。全都找不到时抛 `ChatGPTWebTransportUnavailableError`，**不会在 import 期崩进程**，错误文案是固定的：

```plaintext
ChatGPT Web transport unavailable: the curl-impersonate binary was not found.
Run `bun run curl-impersonate:install` for local development,
or set CHATGPT_WEB_CURL_IMPERSONATE_BIN to an absolute path.
```

### 1.2 主机白名单

该传输层是裸子进程，企业 SSRF 栈看不见它，因此**唯一的出向管控就是目的主机白名单**。内置后缀（恒生效）：

```plaintext
chatgpt.com  openai.com  oaiusercontent.com  oaistatic.com  blob.core.windows.net
```

`CHATGPT_WEB_ALLOWED_HOSTS` 只做**追加**，条目会去首尾点号并转小写；匹配规则是「全等或以 `.<suffix>` 结尾」。

> 这里刻意**不做 IP 校验**：demo / 私有化部署常把 `chatgpt.com` 解析到 fake-IP 段（198.18/15）再经代理出网，按地址判定会把这个服务商唯一的落地方式挡死。域名就是管控点。
> 其余硬约束（不可改）：只允许 `https`（除非 `CHATGPT_WEB_ALLOW_INSECURE_HTTP=1`）、URL 不得带 userinfo、不跟随重定向、请求体上限 64 MiB、header 与 URL 中出现控制字符一律拒绝。

### 1.3 其他固定参数（非环境变量，改需动代码）

`--max-time` 600 s、`--connect-timeout` 20 s、未被读取的响应体 60 s 后杀子进程；curl 以 `--disable` 起头，不读宿主的 `.curlrc`。

## 2. 开发机准备

```bash
bun run curl-impersonate:install
```

- 脚本：`scripts/curlImpersonate/install.mts`；版本、下载源、每个产物的 SHA-256 钉在 `scripts/curlImpersonate/manifest.json`（当前 `v2.1.0`）。
- 校验和不匹配**一律不解压**：HTTPS 只能证明「谁给的文件」，不能证明「是我们审过的那个文件」，而这个二进制会带着服务端凭据运行。
- 支持的平台：`darwin:arm64` / `darwin:x64` / `linux:arm64` / `linux:x64`（linux 取 **musl 静态链接**版；gnu 版是动态链接，塞不进 distroless 镜像）。
- 只从 tar 包里取 `curl-impersonate` 一个文件；同包附带的～40 个 `curl_<browser>` 包装脚本不装（它们内置的 header 集合正是传输层要自己替换的部分）。
- 落地位置 `./.cache/curl-impersonate/curl-impersonate`，同文件系统原子 rename 安装。
- 换镜像源：`CURL_IMPERSONATE_DOWNLOAD_BASE=<prefix>`（默认取 manifest 的 `baseUrl`）。日志只打印来源的 scheme+host，不打印路径 /query/userinfo。

## 3. Docker 镜像

`Dockerfile` 的 `base` 阶段下载静态 musl 版并放进 `/distroless/usr/local/bin/curl-impersonate`，运行阶段用 `ENV CHATGPT_WEB_CURL_IMPERSONATE_BIN="/usr/local/bin/curl-impersonate"` 钉住路径，因此**官方镜像开箱即用，无需额外挂载**。

相关构建参数：

| ARG                                              | 默认          | 说明                                                                                                     |
| ------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------- |
| `CURL_IMPERSONATE_VERSION`                       | `v2.1.0`      | 与 `manifest.json` 的 `version` 保持一致。                                                               |
| `CURL_IMPERSONATE_DOWNLOAD_BASE`                 | 空            | 显式镜像前缀；留空时按 `USE_CN_MIRROR` 选择。                                                            |
| `CURL_IMPERSONATE_SHA256_AARCH64` / `..._X86_64` | 见 Dockerfile | 与 `manifest.json` 里的两个 linux/musl 摘要**重复登记**（shell 阶段读不了 JSON），改版本时两处必须同步。 |
| `USE_CN_MIRROR=true`                             | —             | 下载源换成 `https://ghfast.top/https://github.com/…`（国内网络构建必带）。                               |

镜像构建期会 `sha256sum -c`、拒绝符号链接、`chmod 755` 并执行一次 `--version` 自检，任一步失败即构建失败。CA bundle 由镜像自带的 `ca-certificates` 提供。

## 4. 接入流程（管理端 / 用户端）

服务商卡片：`packages/model-bank/src/modelProviders/chatgptWeb.ts`。关键位：`authType: 'oauthDeviceFlow'` + `oauthDeviceFlow.grantFlow: 'authorization_code_paste'` + `refreshTokenGrant: true`（因此复用既有的**共享 OAuth + 轮转刷新**机制，没有新增管理端 procedure）、`allowAccessTokenPaste: true`、`nativeFileInput: true`、`searchMode: 'params'`、`showApiKey: false`。

### 4.1 两种连接方式

| 方式                                  | 入口文案                                                                          | 是否自动续期                       | 适用                     |
| ------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------- | ------------------------ |
| **打开授权页 → 粘贴回调 URL**（推荐） | 「打开授权页面」→ 登录 → 复制浏览器地址栏整串 → 粘到「回调地址」→「连接共享账号」 | **是**（拿到 `oauthRefreshToken`） | 常规接入                 |
| **粘贴访问令牌**（兜底）              | 「改用访问令牌连接」→ 粘 access token →「使用该令牌连接」                         | **否**                             | 授权页走不通时的临时手段 |

- 授权后会跳到 `https://platform.openai.com/auth/callback?code=…` 的**空白页**，那串完整地址就是要粘的内容。链接一次性绑 `state`/PKCE verifier，换过一次要点「重新生成链接」再登录，否则报「该链接属于另一次连接尝试」。
- 访问令牌方式没有 refresh token，界面会明确提示「访问令牌无法自动续期，一旦过期共享账号将停止工作，需要管理员重新连接」，并在有 `exp` 时显示「请在 {{time}} 之前重新连接」。
- **重复连接会清空上一次未提供的字段**：用访问令牌重连一个原本 OAuth 连上的账号，会把 refresh token 抹掉、退化成不可续期。
- 管理端（共享账号）：`src/enterprise/client/features/admin/ai/providerSettings/SharedOAuthConnect.tsx` + `SharedOAuthPasteForm.tsx`，写平台 Vault（`admin.aiProviderOAuth`）。
  用户端（个人账号，平台未接管时可见）：设置 → 服务商 → `OAuthDeviceFlowAuth/PasteFlowPanel.tsx`，写调用方自己的 Vault（`lambda/oauthDeviceFlow`）。两侧文案一致，仅提交按钮不同（「连接共享账号」/「完成连接」）。

### 4.2 凭据落点

`chatgptweb` 的 Vault 叶子（`credentialAdapter.ts` 的 `SPECIAL_KEYS`）：`oauthAccessToken`（**必填**，缺失即判连接不完整）、`oauthRefreshToken`（可选，**它在不在就是能不能自动续期的判据**）、`oauthTokenExpiresAt`、`oauthAccountId`、`oauthAccountEmail`（仅展示）、`oauthDeviceId`（sentinel 用的稳定 `oai-device-id`，非机密）、`oauthLastRefreshAt` / `oauthLastRefreshErrorAt`（续期簿记，epoch 毫秒字符串，非机密，见 §4.4）。

### 4.3 首次连接与模型开启

首次连接（`mode: 'create'`）会把服务商置为 `enabled: true`、写入 `checkModel: 'auto'`，并**自动物化卡片里默认开启的内置模型**（`adminService.models.ts` 的 `materializeBuiltinDefaultModels`，取 `packages/model-bank/src/aiModels/chatgptWeb.ts` 中 `enabled: true` 的条目）：`auto`、`gpt-5-6`、`gpt-5-6-thinking`、`gpt-5-6-instant`、`gpt-5-6-pro`、`gpt-image-2`。落下来的是**已开启**的真实模型行（带卡片元数据，图像模型也在内），所以连上即可用，不需要再手动勾选。

- 物化随服务商创建走同一次发布，不额外要求 `AI_MODEL_CREATE` 权限（这批行是内置卡片而非管理员自建模型）。
- **重连不会重新物化**：已有的模型行原样保留，管理员之后的开关 / 删除不会被连接动作覆盖回去。

### 4.4 令牌续期与失效

共享账号的续期完全复用通用的轮转刷新管线（`apps/server/src/services/oauthDeviceFlow/refresh.ts`），管理端没有单独的续期开关：

- **提前量（skew）**：默认在到期前 2 分钟刷新；`chatgptweb` 的卡片把它调到 **24 小时**（`settings.oauthDeviceFlow.refreshSkewMs`），因为 OpenAI 会丢弃长期不用的 refresh token。**这是卡片常量，不是环境变量**，改动需要动代码。
- **强制保活**：距上次成功刷新满 **3 天**就强制续一次，即使 access token 还没到期。锚点是 Vault 里的 `oauthLastRefreshAt`（连接时即写入，之后每次成功刷新前移）。
- **失败退避**：一次刷新失败会写 `oauthLastRefreshErrorAt`，**5 分钟**内不再主动重试；但 access token 已经真的过期时不退避（此时没有可保护的凭据）。重新连接会清掉这个标记。
- **平台侧后台巡检**：`sharedOAuthKeepalive.ts` 每 **1 小时**扫一次（`platform_jobs` 里一行租约兼下次到期标记，失败后 5 分钟重试），每轮最多续 3 个服务商，只处理 `enabled` 且有密文的平台行。个人（用户自己的）连接**没有后台任务**，靠下一次请求惰性续期。
- **访问令牌方式无法续期**：没有 refresh token 的连接不参与上述任何一项，到期即停，只能管理员重连（面板 `canRefresh: false`）。
- 管理端「共享账号」卡片读的是 `admin.aiProviderOAuth.getConnectionStatus`：`expiresAt` / `lastRefreshAt` 都是 epoch 毫秒字符串，`expired: true` 表示 refresh token 已被上游判死（`invalid_grant`），必须重连；瞬时刷新失败不会置该位，只会退回已存值。

### 4.5 连通性检查

检查走的是 impersonate 传输层（不是 SafeOutbound 适配器），并按流式探测（15 s 建连预算 / 45 s 流预算）。失败码与常见含义：

| 失败码                                     | 含义                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `connection_failed_transport`              | **服务器上没有 curl-impersonate**（见 §1.1 / §3）。界面文案：「该服务商依赖的组件未安装在服务器上。请联系管理员安装后，再重试检查。」 |
| `connection_failed_shared_account_expired` | 令牌过期 / 被吊销，需重新连接。                                                                                                       |
| `connection_failed_auth`                   | 401 / 403、账号无权限。                                                                                                               |
| `connection_failed_rate_limit`             | 429，上游限流。                                                                                                                       |
| `connection_failed_network`                | 超时 / 中断（含代理不通）。                                                                                                           |
| `connection_failed_invalid_config`         | 该模型对该账号套餐不可用（`model_cap_exceeded`），建议改用 `auto`。                                                                   |
| `connection_failed_provider`               | 其余上游错误（Cloudflare 挑战、PoW、上游 5xx 等）。                                                                                   |

## 5. 已接入的能力范围

全部挂在**项目原有入口**上，没有新页面：

- **对话流式输出**：所有对话都走 `/backend-api/f/conversation`（conduit）通道；仅在无搜索、无附件、无思考档位且属于可恢复的 prepare 失败时，才回落一次旧的 `/backend-api/conversation`。每次创建的会话在结束后会被软隐藏。
- **联网搜索**：聊天框原有的搜索开关。`searchImpl: 'params'`（不是 `'internal'`），因此用户可以**关掉**它。引用以原生 citation 形式回传为 grounding。
- **附件（原生文档上传）**：聊天框原有的附件按钮。`nativeFileInput: true` 的服务商 + 模型 `abilities.files` 才生效；文档以 `file_url` 部件直传上游并等待索引就绪，上传失败时降级为把正文塞进提示词。
- **推理过程**：模型切换面板的推理档位滑杆（`gpt5_6ReasoningEffort`）。
- **回答内嵌图片**：上游返回的图片指针会被下载并以 data URI 内联。
- **代码解释器生成的文件（pdf /docx/ …）**：回答里的 `sandbox:/mnt/data/xxx` 链接会被解析、下载（单文件上限 32 MiB），上传到本平台文件库并**挂到该条消息**上；Markdown 里的 `sandbox:` 链接由 `SandboxFileLink` 插件渲染成可点开的附件，匹配不到附件时退化为纯文本，不会留死链。
- **图像生成 / 编辑**：图像生成页，模型 id **`gpt-image-2`**（对上游实际以 `picture_v2` 流程跑），仅暴露 `prompt` 与最多 4 张、单张 ≤10 MiB 的参考图（有参考图即为「编辑」）；一次调用产出一张图，整体预算 200 s。

### 5.1 生成文件依赖可被浏览器直连的 S3（demo 踩坑）

**客户端模式**下，生成文件的上传是**浏览器侧的 presigned PUT**：客户端拿 `upload.createS3PreSignedUrl` 换预签名地址，再 `XHR PUT` 上去（网关模式改为服务端直传，见 §5.2）。因此：

- `S3_ENDPOINT`（或 `S3_PUBLIC_DOMAIN` / `NEXT_PUBLIC_S3_DOMAIN`）必须是**浏览器能解析并访问**的地址。只在服务端容器网络里可达的地址（如 `http://minio:9000`）会让预签名 URL 在浏览器里直接失败，表现为「生成的文件 … 保存失败，请重试」。
- 存储桶必须开 **CORS**，允许来自 AIHub 站点域名的 `PUT`（参考 `docs/self-hosting/advanced/s3/`）。
- 上传并发 3，支持中断；上传成功但挂载失败时提示「生成的文件未能关联到这条消息，你仍可以在「文件」中找到它们」。

### 5.2 网关模式的生成文件（服务端直传）

`ENABLE_AGENT_GATEWAY` 网关 / 服务端执行路径**同样投递生成文件**，只是上传发生在服务端（`apps/server/src/modules/AgentRuntime/adapters/serverCallLlmGeneratedFile.ts`）：解码 `file` 分片里的 base64 data URI → 以运行发起人的身份写入文件存储 → 写 `messages_files` 挂到该条助手消息 → 再发一个只带**持久化后元数据**（`id` / `name` / `url` / `size` / `fileType`）的 `file` 流分片，客户端据此立刻渲染附件卡片，重新加载消息时由 `messages_files` 水合。

- 单文件上限同样是 **32 MiB**（先按 base64 长度估算再解码，避免大文件撑爆堆）。
- 上传全程**失败即静默丢弃**，不会让整个回答失败；挂载失败但文件已落库时仍会发分片（文件可在「文件」里找到）。
- 上传是并发发起、回合结束前统一 settle 的，因此文件卡片可能比正文稍晚出现。
- 此路径不走浏览器预签名 PUT，`S3_ENDPOINT` 只需**服务端可达**；但生成的访问 URL 仍要能被浏览器打开，§5.1 的公开域名 / CORS 建议依旧适用。

## 6. 已知限制与注意事项

- **上游可能按 IP / 用量静默降级模型**：SSE 的 `server_ste_metadata` 里带回真实 `model_slug`，但当前代码只解析不消费，界面**不会提示**你实际被降级到了 `gpt-5-6-mini` 之类。目录里这两张卡的说明已写明「用量达限时使用的更快更轻的 GPT-5.x 变体」，但默认关闭。
- **思考档位只有三档**：上游只接受 `standard` / `extended` / `max`（`low`/`medium`/`high` 会被 422 拒绝）。界面 6 档滑杆的映射是 `low|medium|standard → standard`、`high|xhigh|extended → extended`、`max → max`、`none|minimal|auto` → 不发该字段。
- **带显式思考档位的回合几乎必然走 handoff/resume**：上游先回一个空流 + `stream_handoff`，答案在 `/f/conversation/resume` 上重放（最多链 3 次）。预算耗尽时回合标 `recoveryRequired`，运行时改为轮询会话文档最多 240 s 补齐后缀。表现为「首字慢」，不是故障。
- **限流来自共享账号本身**：所有成员共用一个 ChatGPT 账号的配额，429 是终态错误（不重试、不回落）。图片生成配额虽然协议里能读（`limits_progress`），当前**没有做任何预检**。
- **`model_cap_exceeded`** 映射为 `ModelNotFound`，是为了让界面建议切到 `auto`；它不属于可回落错误。
- **Cloudflare 挑战会一刀切**：一旦被判为 bot，所有路径同时不可用，没有降级方案；此时优先确认 curl-impersonate 版本 / 画像（`chrome136`）与出网 IP。
- **协议常量会腐坏（ROTS）**：`OAI_CLIENT_VERSION` / `OAI_CLIENT_BUILD_NUMBER`、PoW /turnstile 用的一批浏览器内部键名写死在 `constants.ts`。它们只是 bootstrap HTML 抓取失败时的兜底，但上游改版后可能需要刷新。
- **合规提醒**：把一个 ChatGPT 个人 / Plus 账号共享给全平台成员使用，属于 OpenAI 服务条款的灰区（账号共享、非官方 API 访问）。是否以「平台托管」形式对全员开放，需要业务侧自行评估并承担风险；出问题时的典型后果是账号被限流或封禁，届时所有成员同时不可用。

## 7. 排障速查

| 现象                                                 | 先看                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 检查报「组件未安装」/ 运行时报 transport unavailable | 服务器上有没有 `curl-impersonate`；`CHATGPT_WEB_CURL_IMPERSONATE_BIN` 指的文件是否可执行 |
| 403 / Cloudflare                                     | 画像是否仍为 `chrome136`；出网 IP 是否被风控；有没有绕过传输层用了 Node fetch            |
| TLS 握手失败（内网 TLS 拦截）                        | `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS`                                                  |
| 代理不生效                                           | `PROXY_URL` / `HTTPS_PROXY`（代理串只进 stdin config，`ps` 里看不到是正常的）            |
| 目的主机被拒（`destination host … is not allowed`）  | `CHATGPT_WEB_ALLOWED_HOSTS` 是否需要追加后缀                                             |
| 生成文件保存失败                                     | §5.1：`S3_ENDPOINT` 浏览器可达性 + 桶 CORS（客户端模式的预签名 PUT）                     |
| 生成文件根本没出现                                   | §5.2：服务端 `DEBUG=lobe-*` 里 `[file]` 的丢弃原因（超 32 MiB / 上传失败 / 无 userId）   |
| 共享账号突然全员失效                                 | §4.4：面板 `expired` 是否为真（需重连）；是否用的是无法续期的「访问令牌」连接            |

服务端调试：`DEBUG=lobe-chatgptweb:*`（子命名空间 `runtime` / `client` / `stream` / `image` / `image-resolve`）；`DEBUG_CHATGPTWEB_CHAT_COMPLETION=1` 打印对话请求体。日志里不会出现令牌、签名 URL 的 query 与路径。

## 相关文档

- [reference/trpc-api.md](./reference/trpc-api.md) — `aiProviders` / `aiModels` 接口与权限。
- [reference/admin-routes.md](./reference/admin-routes.md) — `/admin/ai/providers` 等管理端路由。
- [../self-hosting/advanced/s3/](../self-hosting/advanced/s3/) — S3 存储桶与跨域配置。
