# ChatGPT Web 服务商运维手册

> 2026-08-15 制定，对应 `ae772f2b84..2ca058c20a`。
> 服务商 id `chatgptweb`、显示名 **ChatGPT Web**，直连 `chatgpt.com` 的网页端私有协议（非 OpenAI Platform API），因此它比其他服务商多一个**运维前置条件**：服务端必须能加载 `libcurl-impersonate`（持久 HTTP/2 传输）或运行 `curl-impersonate` 二进制（CLI 回落）。
> 本文只描述当前代码的真实行为；协议细节以 `packages/model-runtime/src/providers/chatgptWeb/` 为准。

## 0. 为什么需要一个额外的二进制

`chatgpt.com` 与 `chatgpt.com/backend-api/*` 在 Cloudflare bot-fight 之后，校验的是 **TLS / HTTP2 指纹**而不是请求头：Node 自带的 `fetch` 无论带什么 header、带不带 `Authorization`，都会拿到 `403` + `cf-mitigated: challenge`。所以服务端用 [`lexiforest/curl-impersonate`](https://github.com/lexiforest/curl-impersonate) 发请求：**默认优先**通过 `koffi` 加载 `libcurl-impersonate` 共享库，在进程内复用 HTTP/2 连接（同一浏览器上下文 + 源 + 出口 + 画像修订共用一个连接池，并行流在同一条连接上多路复用）；库缺失、加载失败或 `CHATGPT_WEB_TRANSPORT=cli` 时回落到原来的 `curl-impersonate` 子进程。画像仍从平台的[共享浏览器设备画像](./browser-device-profile.md)取得匹配的 impersonate 目标、UA、UA-CH、语言、时区、屏幕与硬件特征。画像由安装 seed 生成、不会读取管理员电脑，并在管理员主动刷新前保持稳定。实测画像池中的 chrome136–150 今天都能过 Cloudflare；「异常登录」（unusual login）警告来自 OpenAI 的**应用层风控**，出网 IP / 地理是最大剩余信号，不是 CF bot filter。每条连接还有一份进程内 Netscape Cookie 罐（按 `oauthDeviceId` 分桶，画像刷新时一并清空）和一个进程生命周期内稳定、重启后轮换的 UUIDv4 `OAI-Session-Id`。

- 传输层代码：`apps/server/src/enterprise/services/chatgptWeb/transport/`（仅服务端；`packages/model-runtime` 必须保持同构，运行时通过构造参数注入 `fetch`）。
- 注入点：`apps/server/src/modules/ModelRuntime/index.ts`（用户路径）、企业 `runtimeAdapter.ts`（平台托管路径）、`connectionTestService.ts`（管理端连通性检查）。
- OAuth 令牌端点（`auth.openai.com`）用普通 `fetch` 即可，不走该传输层。

## Context engineering

ChatGPT Web、Cursor、Grok Build 是网页版应用服务商（`settings.webApp: true`）：跳过日期 / 模型信息 / 默认助手样板提示的注入。ChatGPT Web 会把 system 文本折进 user 轮次，这些行否则会原样出现在 chatgpt.com 上。任何用户自己写的 system prompt（自定义 Agent，或改过 Inbox 提示词）仍会原样发送。

## 1. 环境变量

| 变量                                   | 默认值 | 说明                                                                                                                                                                                 |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHATGPT_WEB_CURL_IMPERSONATE_BIN`     | 空     | `curl-impersonate` 可执行文件的**绝对路径**。显式指定时若不可执行，直接报错（不再继续探测）。                                                                                        |
| `CHATGPT_WEB_LIBCURL_IMPERSONATE_PATH` | 空     | `libcurl-impersonate` 共享库的**绝对路径**（macOS `.dylib` / Linux `.so`）。显式指定时若无法加载，持久传输不可用（`auto` 回落 CLI；`persistent` 直接报错）。                         |
| `CHATGPT_WEB_TRANSPORT`                | `auto` | `auto`（默认）：能加载库就走持久 HTTP/2，否则 CLI。`persistent`：必须走库，失败即不可用。`cli`：强制子进程，忽略库。                                                                 |
| `CHATGPT_WEB_ALLOWED_HOSTS`            | 空     | 追加到传输层主机白名单的**域名后缀**，英文逗号分隔。内置白名单恒生效。                                                                                                               |
| `CHATGPT_WEB_ALLOW_INSECURE_HTTP`      | `0`    | 置 `1` 允许该传输层走明文 `http`。**仅供测试 / 本地 mock 后端**，生产不要开。                                                                                                        |
| `PROXY_URL` / `HTTPS_PROXY`            | 空     | 复用既有出网代理变量（也识别小写 `https_proxy`）。**CLI**：作为 `proxy =` 写进子进程 stdin config，不进 argv / `ps`。**持久传输**：`CURLOPT_PROXY` 设在进程内句柄上，同样不进 argv。 |
| `SSL_CERT_FILE`                        | 空     | CA bundle；未设置时回落 `NODE_EXTRA_CA_CERTS`。**CLI**：`--cacert`。**持久传输**：`CURLOPT_CAINFO`。静态 musl 版 curl 自带的证书路径可能与宿主不同，内网 TLS 拦截场景需要显式指定。  |

`.env.example` 的 `## ChatGPT Web ###` 段落列出五个变量：`CHATGPT_WEB_CURL_IMPERSONATE_BIN`、`CHATGPT_WEB_LIBCURL_IMPERSONATE_PATH`、`CHATGPT_WEB_TRANSPORT`、`CHATGPT_WEB_ALLOWED_HOSTS`、`CHATGPT_WEB_ALLOW_INSECURE_HTTP`。官方镜像已钉住二进制与库路径。

两种传输的凭据与回收方式不同，不要混着读：

- **持久传输**（默认，`auto` 且库可加载）：TLS / HTTP2 指纹留在进程内的 libcurl-impersonate 连接池，同一 `(browser context, origin, proxy/egress, impersonation profile revision)` 上的 prepare /conversation/ Sentinel 复用一条 HTTP/2 连接，并行流多路复用。代理凭据只存在进程内存（`CURLOPT_PROXY`），从未出现在 argv。调用方不读响应体时，从 multi 上摘掉对应 easy handle，不杀进程。
- **CLI 回落**（库缺失 / 加载失败 / `CHATGPT_WEB_TRANSPORT=cli`）：每个请求一个 `curl-impersonate` 子进程。代理凭据只写进 stdin 的 config。调用方不读响应体时，杀子进程。

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

### 1.1a 共享库解析顺序

持久传输解析 `libcurl-impersonate` 的顺序（取第一个能被 `koffi` 加载的常规文件）：

1. `CHATGPT_WEB_LIBCURL_IMPERSONATE_PATH`；
2. 仓库内 `./.cache/curl-impersonate/libcurl-impersonate.dylib`（macOS）或 `libcurl-impersonate.so`（Linux）（开发机，见 §2）；
3. `/usr/local/lib/libcurl-impersonate.so`（Docker 镜像内置位置）。

全都找不到（或 `CHATGPT_WEB_TRANSPORT=auto` 时加载失败）就回落 §1.1 的 CLI 二进制。`CHATGPT_WEB_TRANSPORT=persistent` 时不回落，直接报传输不可用。

### 1.2 主机白名单

两种传输都不走企业 SSRF 栈（CLI 是裸子进程；持久传输是进程内 libcurl），因此**唯一的出向管控就是目的主机白名单**。内置后缀（恒生效）：

```plaintext
chatgpt.com  openai.com  oaiusercontent.com  oaistatic.com  blob.core.windows.net
```

`CHATGPT_WEB_ALLOWED_HOSTS` 只做**追加**，条目会去首尾点号并转小写；匹配规则是「全等或以 `.<suffix>` 结尾」。

> 这里刻意**不做 IP 校验**：demo / 私有化部署常把 `chatgpt.com` 解析到 fake-IP 段（198.18/15）再经代理出网，按地址判定会把这个服务商唯一的落地方式挡死。域名就是管控点。
> 其余硬约束（不可改）：只允许 `https`（除非 `CHATGPT_WEB_ALLOW_INSECURE_HTTP=1`）、URL 不得带 userinfo、不跟随重定向、请求体上限 64 MiB、header 与 URL 中出现控制字符一律拒绝。

### 1.3 其他固定参数（非环境变量，改需动代码）

请求预算两边相同：整请求 600 s、连接 20 s。未读完的响应体 60 s 后回收，但回收动作不同：

- **CLI**：杀 `curl-impersonate` 子进程（先 SIGTERM，再 SIGKILL）。
- **持久传输**：从 multi 上 `curl_multi_remove_handle` 并 `easy_cleanup`，进程继续活着。

CLI 以 `--disable` 起头，不读宿主的 `.curlrc`。

## 2. 开发机准备

```bash
bun run curl-impersonate:install
```

- 脚本：`scripts/curlImpersonate/install.mts`；版本、下载源、每个产物的 SHA-256 钉在 `scripts/curlImpersonate/manifest.json`（当前 `v2.1.0`）。
- 校验和不匹配**一律不解压**：HTTPS 只能证明「谁给的文件」，不能证明「是我们审过的那个文件」，而这个二进制会带着服务端凭据运行。
- 支持的平台：`darwin:arm64` / `darwin:x64` / `linux:arm64` / `linux:x64`。CLI 二进制 linux 取 **musl 静态链接**版；**库**取 **gnu** 动态链接版（koffi 加载；glibc 由 Node 运行时提供）。
- 二进制：只从 tar 包里取 `curl-impersonate` 一个文件；同包附带的～40 个 `curl_<browser>` 包装脚本不装（它们内置的 header 集合正是传输层要自己替换的部分）。落地 `./.cache/curl-impersonate/curl-impersonate`。
- 库：只取真实成员（`libcurl-impersonate.4.8.0.dylib` / `libcurl-impersonate.so.4.8.0`，不解 symlink），落地为 `./.cache/curl-impersonate/libcurl-impersonate.dylib`（macOS）或 `libcurl-impersonate.so`（Linux），mode `0755`。旁边写 `libcurl-impersonate.version`（manifest 版本）。版本未变则跳过下载。版本变了会**先删掉**稳定库再下新的：升级失败时目录里不会留下旧库，警告「no library installed → CLI fallback」是真话。库失败**不阻断**二进制安装。
- 换镜像源：`CURL_IMPERSONATE_DOWNLOAD_BASE=<prefix>`（默认取 manifest 的 `baseUrl`）。带 `user:password@` 的前缀会剥掉 userinfo、改走 `Authorization: Basic`（Node `fetch` 拒带凭据的 URL）。日志只打印 scheme+host，不打印路径 /query/userinfo，也不打印 fetch 异常原文。

## 3. Docker 镜像

`Dockerfile` 的 `base` 阶段下载静态 musl 版二进制到 `/distroless/usr/local/bin/curl-impersonate`，并下载 linux-gnu `libcurl-impersonate.so.4.8.0` 安装为 `/distroless/usr/local/lib/libcurl-impersonate.so`。运行阶段钉住

```plaintext
CHATGPT_WEB_CURL_IMPERSONATE_BIN=/usr/local/bin/curl-impersonate
CHATGPT_WEB_LIBCURL_IMPERSONATE_PATH=/usr/local/lib/libcurl-impersonate.so
```

因此**官方镜像开箱即用，无需额外挂载**。`COPY --from=base /distroless/` 与后续 layer-a 对 `/usr` 的整树拷贝会把库带进最终 scratch 镜像。

相关构建参数：

| ARG                                                 | 默认          | 说明                                                                                              |
| --------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `CURL_IMPERSONATE_VERSION`                          | `v2.1.0`      | 与 `manifest.json` 的 `version` 保持一致（二进制与库同一 release）。                              |
| `CURL_IMPERSONATE_DOWNLOAD_BASE`                    | 空            | 显式镜像前缀；留空时按 `USE_CN_MIRROR` 选择。二进制与库共用。                                     |
| `CURL_IMPERSONATE_SHA256_AARCH64` / `..._X86_64`    | 见 Dockerfile | 与 `manifest.json` `assets` 里的两个 linux/musl **二进制**摘要重复登记（shell 阶段读不了 JSON）。 |
| `LIBCURL_IMPERSONATE_SHA256_AARCH64` / `..._X86_64` | 见 Dockerfile | 与 `manifest.json` `libraries` 里的两个 linux-gnu **库**摘要重复登记。改版本时四处必须同步。      |
| `USE_CN_MIRROR=true`                                | —             | 下载源换成 `https://ghfast.top/https://github.com/…`（国内网络构建必带）。                        |

镜像构建期会 `sha256sum -c`、拒绝符号链接、`chmod 755`，二进制跑一次 `--version`，库跑一次 `ldd`（不得出现 `not found`），任一步失败即构建失败。CA bundle 由镜像自带的 `ca-certificates` 提供。

## 4. 接入流程（管理端 / 用户端）

服务商卡片：`packages/model-bank/src/modelProviders/chatgptWeb.ts`。关键位：`authType: 'oauthDeviceFlow'` + `oauthDeviceFlow.grantFlow: 'authorization_code_paste'` + `refreshTokenGrant: true`（因此复用既有的**共享 OAuth + 轮转刷新**机制，没有新增管理端 procedure）、`allowAccessTokenPaste: true`、`webSessionOnly: true`、`nativeFileInput: true`、`searchMode: 'params'`、`showApiKey: false`。

### 4.1 连接方式：只有「粘贴网页会话」

| 方式                             | 入口文案                                                  | 是否自动续期                             | 适用                       |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------- | -------------------------- |
| **粘贴网页会话（Cookie /cURL）** | 「使用 chatgpt.com 网页会话连接」→ 粘贴 →「连接共享账号」 | **是**（存的是 next-auth 会话，见 §4.4） | 唯一的连接方式             |
| **粘贴访问令牌**（兜底）         | 同一个输入框，粘 access token 即可（会被自动识别）        | **否**                                   | 临时手段，到期即停需要重连 |

- **OAuth 授权页已从两端 UI 移除**（卡片 `oauthDeviceFlow.webSessionOnly: true`，谓词 `isProviderWebSessionOnly`）。原因：那条授权 URL 的 `audience` 是 `https://api.openai.com/v1`、`redirect_uri` 落在 `platform.openai.com`—— 它登录的是 **OpenAI 平台（API）**，不是本服务商实际调用的 chatgpt.com 订阅；换出来的令牌能入库却可能在 `chatgpt.com/backend-api` 上全线 403。服务端也一并把它堵死：`admin.aiProviderOAuth.pollAuthStatus` 与 `lambda.oauthDeviceFlow.pollAuthStatus` 收到 `callbackUrl` 时直接拒（`PLATFORM_CONFIG_VALIDATION_FAILED` / `BAD_REQUEST`），不再兑换。
- **存量兼容**：卡片里的 `authorizationCode` / `clientId` / `tokenEndpoint` / `scopes` **保留不删**。已经以 `oauthRenewalKind: 'oauth'` 存在的连接照常在 `auth.openai.com/oauth/token` 续期（`refreshAccessToken` 的 `'oauth'` 分支未动），被去掉的只是「新建连接的入口」。
- `initiateDeviceCode` **仍然保留**：会话路径也要靠它产出信封里的 `deviceId`（`oai-device-id` 的稳定来源）。
- **粘贴区只有一个多行输入框**，粘什么由客户端识别（`packages/utils/src/chatgptWebPaste.ts`）：原始 Cookie 值、`Cookie: …` 整行、开发者工具「复制为 cURL」的整条命令（bash /cmd/ PowerShell 引号都行，`-b` 与 `-H 'cookie: …'` 都认）、`/api/auth/session` 的 JSON 响应体、`Bearer <jwt>`、裸 access token。next-auth 把超长会话切成 `…session-token.0/.1` 时会按序拼回。输入框下方实时显示「已识别：网页会话（可自动续期）/ 访问令牌（无法自动续期）/ 无法识别」，识别不出就禁用提交。**同时粘到会话和令牌时永远存会话**（能续期的那个）。
- 已经用访问令牌连上的，连接卡片会出现**告警条**（不是一行灰字）：「当前连接无法自动续期，将于 … 失效。粘贴网页会话即可自动续期」（有 `exp` 时带失效时间），告警条上直接给出 \*\*「粘贴网页会话」\*\* 主按钮（点开即落在会话输入框）。管理端与用户端两侧行为一致。
- 反过来，可续期连接的状态行说的是「已连接，自动续期中（网页会话 / 授权登录）」，另起一行「当前访问令牌有效期至 {{time}}」并附「上次续期于 {{time}}」——`expiresAt` 在这里是轮转日期而不是最后期限，不要按告警读。
- **令牌来源校验**：粘贴的（以及会话签出的）access token 会解 `client_id` 声明，Codex CLI 客户端 `app_EMoamEEZ73f0CkXaXp7hrann` 没有网页版权限，连接时直接拒（`token_not_web`，文案指向改粘网页会话）。已知可用的是网页客户端 `app_X8zY6vW2pQ9tR3dE7nK1jL5gH` 与本仓库 PKCE 用的 `app_2SKx67EdpoN0G6j64rFvigXD`；**其余未知 client\_id 一律放行**（清单不是公开契约，且令牌随后还要过 `/backend-api/me`）。
- **重复连接会清空上一次未提供的字段**：用访问令牌重连一个原本可续期的账号，会把续期凭据（会话 /refresh token）连同 `oauthRenewalKind` 一起抹掉、退化成不可续期。
- 管理端（共享账号）：`src/enterprise/client/features/admin/ai/providerSettings/SharedOAuthConnect.tsx` + `SharedOAuthPasteForm.tsx`，写平台 Vault（`admin.aiProviderOAuth`）。
  用户端（个人账号，平台未接管时可见）：设置 → 服务商 → `OAuthDeviceFlowAuth/PasteFlowPanel.tsx`，写调用方自己的 Vault（`lambda/oauthDeviceFlow`）。两侧文案一致，仅提交按钮不同（「连接共享账号」/「完成连接」）。两个组件都按 `webSessionOnly` 这一个 prop 切换版式，**不硬编码服务商 id**—— 没有该标志的服务商（授权页 + 折叠粘贴区）行为完全不变。

### 4.2 凭据落点

`chatgptweb` 的 Vault 叶子（`credentialAdapter.ts` 的 `SPECIAL_KEYS`）：`oauthAccessToken`（**必填**，缺失即判连接不完整）、`oauthRefreshToken`（可选，**它在不在就是能不能自动续期的判据**）、`oauthRenewalKind`、`oauthTokenExpiresAt`、`oauthAccountId`、`oauthAccountEmail`（仅展示）、`oauthDeviceId`（sentinel 用的稳定 `oai-device-id`，非机密）、`oauthLastRefreshAt` / `oauthLastRefreshErrorAt`（续期簿记，epoch 毫秒字符串，非机密，见 §4.4）。

- **`oauthRenewalKind`**：`'oauth' | 'web_session'`（闭合枚举，定义在 `services/oauthDeviceFlow/index.ts` 的 `OAUTH_RENEWAL_KINDS`），说明 `oauthRefreshToken` 里装的是**哪种**续期凭据 ——OAuth refresh token，还是 chatgpt.com 的 next-auth 会话 Cookie。非机密（和续期簿记一样，只是标签），**连接时写入、续期时按实际消费的那份凭据带过**（轮转换的是凭据本身，不是种类），重连时与 `oauthRefreshToken` **成对移动**（换一种方式重连必须把旧标签一起换掉，否则下一次续期会去错的端点）。
  - **写入侧校验**：管理端凭据写入（`validateAiCatalogCredentialShape`）会拒绝不认识的取值，也会拒绝**只写标签不写凭据**的组合。
  - **读取侧容错**：持久化里读到不认识的取值一律**按缺失处理**（`parseOAuthRenewalKind`），继续走形状兜底 —— 旧代码写下的标签不能把一个还在工作的连接判死。缺叶子 / 取值不认识时按**凭据形状**兜底：五段、头部 `alg: 'dir'` 的紧凑 JWE 就是网页会话（`isChatGPTWebSessionToken`）。
- **`oauthDeviceId`** 不只在连接时用：`refresh.ts` 会把它随 `OAuthRefreshOptions` 一起交给服务商，网页会话续期时作为 `oai-did` Cookie 一并送出（平台侧的租约内重读同样带上它）。少了它，每次续期在上游看来都是一台新设备 —— 而这条路径本来就是靠指纹传输层过风控的。运行时还用它做两件事：参与派生进程生命周期内的 UUIDv4 `OAI-Session-Id`，以及给 curl-impersonate 选一份进程内 Netscape Cookie 罐（`$TMPDIR/aihub-chatgptweb-jars/`，按 device id 分桶；连接 / 重连 / 断开时清空，进程重启也会丢）。跨源资源下载（blob / CDN）不会带上这份罐子，也不会带 `Authorization` / `OAI-*`。
- **会话值的边界规则**：会话 token 最终会被拼进 `Cookie:` 请求头，所以它在 **tRPC 输入契约**（`chatgptWebSessionTokenSchema`）和**服务边界**上都只接受 base64url + `.` 的字符集（`CHATGPT_WEB_SESSION_TOKEN_PATTERN`，≤16 KiB）—— 带 `;` `,` `=`、空白或控制字符的粘贴一律拒（`session_invalid`），上游轮转回来的新值同样过这条规则。

### 4.3 首次连接与模型开启

首次连接（`mode: 'create'`）会把服务商置为 `enabled: true`、写入 `checkModel: 'auto'`，并**自动物化卡片里默认开启的内置模型**（`adminService.models.ts` 的 `materializeBuiltinDefaultModels`，取 `packages/model-bank/src/aiModels/chatgptWeb.ts` 中 `enabled: true` 的条目）：`auto`、`gpt-5-6`、`gpt-5-6-instant`、`gpt-5-6-thinking`、`gpt-5-6-pro`、`gpt-image-2`。落下来的是**已开启**的真实模型行（带卡片元数据，图像模型也在内），所以连上即可用，不需要再手动勾选。目录按上游 slug **1:1** 展示（管理员配置什么，用户就看到什么；发送时不改写 slug）。`gpt-5-5-*`、minis、`o3` 默认关闭。同步上游模型会把各 SKU 的 `extendParams` 正规化为 thinking / pro / 无，并清掉旧的 family-card `legacyAlias` 戳记。

- 物化随服务商创建走同一次发布，不额外要求 `AI_MODEL_CREATE` 权限（这批行是内置卡片而非管理员自建模型）。
- **重连不会重新物化**：已有的模型行原样保留，管理员之后的开关 / 删除不会被连接动作覆盖回去。

### 4.4 令牌续期与失效

共享账号的续期完全复用通用的轮转刷新管线（`apps/server/src/services/oauthDeviceFlow/refresh.ts`），管理端没有单独的续期开关：

- **提前量（skew）**：默认在到期前 2 分钟刷新；`chatgptweb` 的卡片把它调到 **24 小时**（`settings.oauthDeviceFlow.refreshSkewMs`），因为 OpenAI 会丢弃长期不用的 refresh token。**这是卡片常量，不是环境变量**，改动需要动代码。
- **强制保活**：距上次成功刷新满 **3 天**就强制续一次，即使 access token 还没到期。锚点是 Vault 里的 `oauthLastRefreshAt`（连接时即写入，之后每次成功刷新前移）。
- **失败退避**：一次刷新失败会写 `oauthLastRefreshErrorAt`，**5 分钟**内不再主动重试；但 access token 已经真的过期时不退避（此时没有可保护的凭据）。重新连接会清掉这个标记。
- **平台侧后台巡检**：`sharedOAuthKeepalive.ts` 每 **1 小时**扫一次（`platform_jobs` 里一行租约兼下次到期标记，失败后 5 分钟重试），每轮最多续 3 个服务商，只处理 `enabled` 且有密文的平台行。个人（用户自己的）连接**没有后台任务**，靠下一次请求惰性续期。
- **网页会话方式走的是另一个端点**：`oauthRenewalKind: 'web_session'` 的连接，续期时不打 `auth.openai.com/oauth/token`，而是**经 impersonate 传输层**请求 `GET https://chatgpt.com/api/auth/session`（会话作为 `__Secure-next-auth.session-token` Cookie 带上，附带存下来的 `oai-did`），签出新的 access token—— 这正是网页版自己在做的事，所以「登录一次就不用再登录」。上面的提前量 / 保活 / 退避 / 单飞 / 跨实例租约 / `invalid_grant` 自愈**全部原样复用**，因为凭据就存在同一个 `oauthRefreshToken` 叶子里。两点必须记住：
  - 响应里的 `Set-Cookie` 会**轮转**会话值，轮转后必须存新值（继续用已消费的那个下次就是 401）；服务端读的是 `Headers.getSetCookie()`，并且**认 next-auth 的分片形式**：会话超过一个 Cookie 时上游发的是 `…session-token.0/.1/…`，服务端按下标**从 0 连续拼回**，同时忽略同一响应里 `Max-Age=0` / 空值的**清理头**。分片有缺口、或拼出来的值不满足字符集，就**整个丢弃这次轮转、继续用手上的值**—— 只读半截存下去等于确定性地废掉凭据，而留用旧值最多是下次 401，走的是已有的重连路径。
  - **Cloudflare 挑战（403 `cf-mitigated: challenge`）、429、5xx、超时一律按瞬时错误处理**，绝不能当成会话失效 —— 把挑战判死会一次性废掉全站共享凭据。只有 **401 或 “成功解析出的响应体里没有 `accessToken`”**（空 `{}` / 只有 `WARNING_BANNER` 的未登录响应）才是**会话真的过期**，此时抛 `OAuthInvalidGrantError`，与 refresh token 失效走同一条「需要重连」的终态路径。
  - **响应体读不出来 ≠ 会话失效**：200 但连接中断 / 截断 / 不是 JSON，按**瞬时**处理并重试，绝不判死凭据。如果这次尝试**已经拿到了轮转值**，重试会改用轮转后的会话（上游一旦轮转，手上那份就已经作废，拿它重试只会白烧剩下的次数）。
  - **调用内自带有界重试**（实测机房 IP 下约 2/3 的请求会被挑战，不重试的话管理员点一次「连接」大概率直接失败）：连接 **4 次**、续期 **3 次**（续期少一次是因为整个调用必须塞进 30s 租约以内），退避 **400 / 900 / 1600 ms 各带 ≤30% 抖动**，每次都是全新的传输调用。**只对瞬时结果重试**——401、200 无令牌、调用方超时 / 中断都不重试（重试一个已死会话只是白烧预算，而超出调用方 deadline 的重试会跑过租约）。整体预算：连接 **25s（覆盖整次连接**—— 会话签发**和**随后的邮箱 / 账号身份探测共用这一条 deadline，探测各自的 10s / 20s 上限只与它取交集）、续期沿用调用方的 20s，另有每次尝试 8s 上限（永远与整体预算取交集，因此不会放大总时长）。日志只在 `debug`（`lobe-server:chatgpt-web-oauth`）打印**尝试次数 + 失败分类**（challenge /rate\_limit/server\_error/forbidden/network），绝不打印令牌或响应内容。重试用尽后仍是瞬时错误，交给上面那条 5 分钟退避在下次请求时再试。
- **`invalid_grant` 自愈按 “重读到的那份凭据” 重试**：自愈会重读持久态再试一次，而这期间的并发重连**可能已经把叶子换成另一种凭据**（网页会话 ⇄ PKCE refresh token，设备 id 也可能不同）。因此续期选项是**按每份凭据自己的 Vault 现算的**，而不是沿用最初那次的种类 —— 否则会把刚存下的 refresh token 当会话 Cookie 送去 chatgpt.com（或反过来），把一个刚建好的连接一次打死。重试仍然共用**最初那条 deadline**（整次续期必须塞进 30s 租约），写回与返回的种类 / 设备 id 都是**实际消费的那份**。
- **访问令牌方式无法续期**：没有续期凭据的连接不参与上述任何一项，到期即停（面板 `canRefresh: false`）。出路只有一条：卡片告警条上的「粘贴网页会话」—— 一次粘贴即可转成可续期。
- 管理端「共享账号」卡片读的是 `admin.aiProviderOAuth.getConnectionStatus`：`expiresAt` / `lastRefreshAt` 都是 epoch 毫秒字符串，`renewalKind` 说明是哪种续期凭据（无凭据时为 `null`），`expired: true` 表示续期凭据已被上游判死（`invalid_grant`，会话过期同样落在这里），必须重连；瞬时刷新失败不会置该位，只会退回已存值。

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
- **推理过程**：模型切换面板的思考档位滑杆。只挂在 `*-thinking`（`chatgptWebThinkingEffort`：standard / extended / max）和 `*-pro`（`chatgptWebProThinkingEffort`：仅 standard）上；不得复用 OpenAI Platform 的 `gpt5_6ReasoningEffort`，也不得骑共享的 `reasoning_effort`。
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

- **上游可能按 IP / 用量静默降级模型**：SSE 的 `server_ste_metadata` 里带回真实 `model_slug`。现在它会被记录下来 —— 与请求的模型不一致时，`DEBUG=lobe-chatgptweb:stream` 打印一行 `upstream served <slug> for a turn that requested <model>`，同一个值也随 `servedModel` 进入流的 `onDone` 上下文。**界面仍然不会提示**（协议层没有「实际模型 ≠ 请求模型」的通用槽位，加一个要动 `StreamProtocolChunk` + `fetchSSE` + 消息元数据三层），所以怀疑被降级时先看这行日志。目录里两张 mini 卡的说明已写明「用量达限时使用的更快更轻的 GPT-5.x 变体」，但默认关闭。
  - 注意 **`auto` 本来就会被上游路由**：选 `auto` 时服务到 `gpt-5-6-mini` 是上游分流器的正常行为，不是故障。拿浏览器里手选 GPT-5.6 去对比平台上的 `auto`，两边不可比。

- **请求体里不会出现 `author.role: "system"`**：网页版自己从不发系统角色回合（自定义指令走另一套带标记的元数据），所以带自由文本的 system 回合是只有自动化客户端才会产出的形状。上下文引擎每一轮都会在 `messages[0]` 塞一条 system（人设、日期、模型信息、工具提示词），运行时会把它**并入紧随其后的那条用户消息**（`buildMessages`）；若下一条是助手回合（或已到末尾），则**就地**单独发成一条用户消息 —— 指令绝不允许跨过助手回合往后挪，否则会打乱对话顺序（`AgentDocumentMessageInjector` 会在首条用户消息之后插 system，这条路径真实可达）。`ChatGPTWebMessage['role']` 已收窄到 `'user' | 'assistant'` 钉住这条不变量。

- **思考档位（1:1 SKU）**：发送时 **slug = 所选模型**，不按档位改写。chatgpt.com 只接受 `thinking_effort` ∈ `standard` | `extended` | `max`（HAR 2026-08-21）。控制键是独立的 `chatgptWebThinkingEffort` / `chatgptWebProThinkingEffort`（不要复用 OpenAI Platform 的 `gpt5_6ReasoningEffort`，也不得骑共享的 `reasoning_effort`）。

  | id | UI | wire |
  | --- | --- | --- |
  | `*-thinking` | standard / extended / max（`chatgptWebThinkingEffort`） | 发送所选值；未设置则省略。旧 agent 的 low/medium/high/xhigh 仍走 `normalizeThinkingEffort` 别名 |
  | `*-pro` | 仅 Standard（`chatgptWebProThinkingEffort`） | **始终** `thinking_effort: standard`（忽略残留值；走既有 dual-prepare Pro 路径） |
  | `auto`、裸 `gpt-5-6` / `gpt-5-5`、`*-instant`、minis、`o3` | 无选择器 | **不**发 `thinking_effort`，即使 payload 里残留 `reasoning_effort` |

  上游仍然**只接受** `standard` / `extended` / `max`（`low`/`medium`/`high`/`instant`/`pro` 都不得出现在 wire 上）。`*-thinking` 的旧别名是 `low|medium|standard → standard`、`high|xhigh|extended → extended`、`max → max`、`none|minimal|auto|instant|pro` → 不发该字段。`/backend-api/f/conversation` 还带固定的 `model_response_contracts`（`photo_upload_action.v1`）；prepare 体不带。

- **带显式思考档位的回合几乎必然走 handoff/resume**：上游先回一个空流 + `stream_handoff`，答案在 `/f/conversation/resume` 上重放（最多链 3 次）。预算耗尽时回合标 `recoveryRequired`，运行时改为轮询会话文档最多 240 s 补齐后缀。表现为「首字慢」，不是故障。

- **限流来自共享账号本身**：所有成员共用一个 ChatGPT 账号的配额，429 是终态错误（不重试、不回落）。图片生成配额虽然协议里能读（`limits_progress`），当前**没有做任何预检**。

- **`model_cap_exceeded`** 映射为 `ModelNotFound`，是为了让界面建议切到 `auto`；它不属于可回落错误。

- **Cloudflare 挑战会一刀切**：一旦被判为 bot，所有路径同时不可用，没有降级方案。chrome136–150 今天都能过 Cloudflare；若仍看到 `cf-mitigated: challenge`，先确认持久化画像通过一致性校验、impersonate 目标与 UA / `sec-ch-ua*` 的主版本相同，并确认没有绕过传输层使用 Node `fetch`。账号侧的「异常登录」是 OpenAI 应用层风控（出网 IP / 地理是最大剩余信号），不是 CF。

- **协议常量会腐坏（ROTS）**：`OAI_CLIENT_VERSION` / `OAI_CLIENT_BUILD_NUMBER`、PoW /turnstile 用的一批浏览器内部键名写死在 `constants.ts`。它们只是 bootstrap HTML 抓取失败时的兜底，但上游改版后可能需要刷新。

- **合规提醒**：把一个 ChatGPT 个人 / Plus 账号共享给全平台成员使用，属于 OpenAI 服务条款的灰区（账号共享、非官方 API 访问）。是否以「平台托管」形式对全员开放，需要业务侧自行评估并承担风险；出问题时的典型后果是账号被限流或封禁，届时所有成员同时不可用。

## 7. 排障速查

| 现象                                                 | 先看                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 检查报「组件未安装」/ 运行时报 transport unavailable | 服务器上有没有 `curl-impersonate`；`CHATGPT_WEB_CURL_IMPERSONATE_BIN` 指的文件是否可执行。若强制了 `CHATGPT_WEB_TRANSPORT=persistent`，再看 `CHATGPT_WEB_LIBCURL_IMPERSONATE_PATH` / `.cache` / `/usr/local/lib/libcurl-impersonate.so` 能否被 koffi 加载                    |
| 403 / Cloudflare                                     | 画像的 impersonate 目标、UA 与 UA-CH 是否同主版本；出网 IP / 地理是否漂移（应用层风控）；有没有绕过传输层用了 Node fetch                                                                                                                                                     |
| TLS 握手失败（内网 TLS 拦截）                        | `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS`                                                                                                                                                                                                                                      |
| 代理不生效                                           | `PROXY_URL` / `HTTPS_PROXY`（代理串只进 stdin config，`ps` 里看不到是正常的）                                                                                                                                                                                                |
| 目的主机被拒（`destination host … is not allowed`）  | `CHATGPT_WEB_ALLOWED_HOSTS` 是否需要追加后缀                                                                                                                                                                                                                                 |
| 生成文件保存失败                                     | §5.1：`S3_ENDPOINT` 浏览器可达性 + 桶 CORS（客户端模式的预签名 PUT）                                                                                                                                                                                                         |
| 生成文件根本没出现                                   | §5.2：服务端 `DEBUG=lobe-*` 里 `[file]` 的丢弃原因（超 32 MiB / 上传失败 / 无 userId）                                                                                                                                                                                       |
| 共享账号突然全员失效                                 | §4.4：面板 `expired` 是否为真（需重连）；是否用的是无法续期的「访问令牌」连接                                                                                                                                                                                                |
| 怀疑被降级到 mini                                    | `DEBUG=lobe-chatgptweb:stream` 里的 `upstream served …` 行；先确认请求的模型不是 `auto`（§6）                                                                                                                                                                                |
| 回落到旧的 `/backend-api/conversation`               | `conversation_prepare returned no conduit token; response shape: …`（`lobe-chatgptweb:client`）给出上游拒发令牌的真实原因；空响应体另有 `returned an empty body`（`lobe-chatgptweb:http`）。回落路径没有 handoff/resume，因此 pro /thinking 档的回合在这条路上拿不到对应模型 |

服务端调试：`DEBUG=lobe-chatgptweb:*`（子命名空间 `runtime` / `client` / `stream` / `image` / `image-resolve`）；`DEBUG_CHATGPTWEB_CHAT_COMPLETION=1` 打印对话请求体。日志里不会出现令牌、签名 URL 的 query 与路径。

## 相关文档

- [browser-device-profile.md](./browser-device-profile.md) — 共享合成画像的生成、存储、刷新与复用接口。
- [reference/trpc-api.md](./reference/trpc-api.md) — `aiProviders` / `aiModels` 接口与权限。
- [reference/admin-routes.md](./reference/admin-routes.md) — `/admin/ai/providers` 等管理端路由。
- [../self-hosting/advanced/s3/](../self-hosting/advanced/s3/) — S3 存储桶与跨域配置。
