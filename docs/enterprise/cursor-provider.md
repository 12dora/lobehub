# Cursor 服务商运维手册

> 服务商 id `cursor`、显示名 **Cursor**。通过平台的 Cursor 账号使用 Composer / Grok / Claude / GPT / Gemini，与 Cursor 命令行工具同源，无需单独的模型 API Key。
> 本文只描述当前代码的真实行为；协议细节以 `packages/model-runtime/src/providers/cursor/` 与 `apps/server/src/services/oauthDeviceFlow/providers/cursor.ts` 为准。

## 0. 它是什么

管理端把 Cursor 配成平台共享服务商后，成员聊天走服务端生成的 `cursor-agent` 子进程（伪 HTTP `https://cursor.local`），不是 Cursor 的公开 HTTP API。该 CLI 在官方镜像里烘焙在 `/opt/cursor-agent`。

Cursor **没有工具调用**（`functionCall: false`）。连通性检查走普通流式 `chat`，不是 OpenAI Responses。

## 1. 接入方式

两条路，写进同一套共享 OAuth 保险库：

| 路径       | 管理员操作                                                                                                                                   | 存什么                                                                                                     | 续期                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------- |
| 浏览器登录 | 打开 `https://cursor.com/loginDeepControl?challenge=&uuid=&mode=login&redirectTarget=cli`，服务端轮询 `GET https://api2.cursor.sh/auth/poll` | `oauthAccessToken`（JWT）、`oauthRefreshToken`（浏览器 refresh）、`oauthRenewalKind=oauth`                 | 见 §2               |
| API Key    | 粘贴 Cursor 控制台的用户 API Key；服务端 `POST https://api2.cursor.sh/auth/exchange_user_api_key`                                            | `oauthAccessToken`（换出的 JWT）、`oauthRefreshToken`（**原 API Key**）、`oauthRenewalKind=cursor_api_key` | 用 API Key 再换一次 |

`userCode` 为空：设备码 UI 只展示 URL。粘贴框按 `pastedCredentialKind: 'apiKey'` 当作 API Key，不是 access token。

## 2. 60 天与重新授权

浏览器登录拿到的 access JWT 大约 **60 天**过期。服务端用 `POST https://api2.cursor.sh/oauth/token`（JSON：`grant_type=refresh_token`、`client_id=KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB`）换新 access token；form-urlencoded 会 415，`POST /auth/refresh` 是 404。400/401 视为死授权（keepalive 打上需要重新授权）；5xx 等瞬时失败不打标，以免一次故障把仍有效的 JWT 写死。

API Key 路径可按需再换 JWT，refresh 字段始终是那把 Key。

共享使用建议：**Team / Enterprise 套餐 + 服务账号 API Key**。个人浏览器登录会把一个人的会话借给全平台，且 60 天后必须有人重新点一次登录。

## 3. 环境变量

| 变量                           | 默认值                                                                                            | 说明                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CURSOR_AGENT_HOME`            | 镜像内 `/opt/cursor-agent`；Mac 开发机未设置                                                      | 含 `index.js` 与捆绑 `node` 的目录。无效值直接失败，不静默回退。                                                                                      |
| `CURSOR_AGENT_STATE_DIR`       | `$LOBE_HOME/cursor-agent`，或存在时 `/app/.lobe/cursor-agent`，否则 `<tmpdir>/aihub-cursor-agent` | 可写 0700 目录树，必须是**专用目录**：填 `/`、`/tmp`、`/var`、`/home`、`/root`、`/app` 等根或系统目录会在启动时直接报错（子目录如 `/var/lib/aihub/cursor-agent` 正常）。`home-<实例标识>/`、`cache/` 与 `config-seed/` 属于整套 AIHub 安装；`turns/<uuid>/` 下的数据、项目、配置与聊天记录只属于当前轮次，结束后删除。 |
| `CURSOR_AGENT_INSTANCE_ID`     | 容器 hostname                                                                                     | 共享状态目录中本实例持久 HOME 的后缀（`home-<实例标识>`），保证多副本不会同时重写同一份技能同步目录。                                                 |
| `CURSOR_AGENT_MAX_CONCURRENCY` | `4`                                                                                               | 同时存在的 CLI 进程上限。                                                                                                                             |
| `CURSOR_AGENT_MAX_QUEUE`       | `16`                                                                                              | FIFO 等待队列上限。队列已满立刻 503 `{error:{code:"overloaded"}}`，与排队超过 60 s 的 503 `queue_timeout` 区分。                                      |
| `CURSOR_AGENT_TURN_TIMEOUT_MS` | `600000`                                                                                          | 卡住的一轮先 SIGTERM，3 秒后再 SIGKILL。                                                                                                              |

`.env.example` 的 `AI Provider Service` 段落已列出（`## Cursor Agent ###`）。

### 安装状态与轮次隔离

服务端把 Cursor CLI 运行环境拆成两层：

- `<stateDir>/home-<实例标识>` 跨轮次保留，因此 `~/.cursor/agent-cli-state.json`、`~/.cursor/skills-cursor/**` 与技能同步清单每个实例只初始化一次；共享的 V8 编译缓存仍位于 `<stateDir>/cache`。实例标识取 `CURSOR_AGENT_INSTANCE_ID`，未设置时取容器 hostname（Docker 中即容器 id）。
- **退役实例的 HOME 由运维手动清理**，服务端不会自动删除。目录 mtime 不是心跳（其下的写入不一定更新根目录时间），据此递归删除随时可能删掉另一副本正在使用的 HOME。缩容或换镜像后，确认对应实例确实不在运行，再执行 `rm -rf <stateDir>/home-<退役实例标识>`；留着也只占磁盘，不影响任何请求。
- 每轮创建 `<stateDir>/turns/<uuid>/config`，启动前只从 `<stateDir>/config-seed` 复制 `cli-config.json` 与 `statsig-cache.json`。轮次结束后只把这两个文件以临时文件加原子重命名的方式写回，并且按**版本比对**（复制时记下种子文件的 sha256，写回前重新计算）：种子在这一轮期间被别的轮次改过就直接放弃写回，避免用旧快照覆盖新结果（原子重命名只能防止读到半个文件，防不了覆盖丢更新）。`chats/**`、`CURSOR_DATA_DIR` 与 `CURSOR_PROJECTS_DIR` 从不进入种子，随轮次根目录一起删除。
- 写回前会先校验轮次配置：无法解析、丢失了种子里已有的 `authInfo` / `version`，或这两个键虽在但值不可用（`authInfo` 不是非空对象、`version` 不是非空字符串或数字），就保留原种子不动。`statsig-cache.json` 同样必须能解析成 JSON 对象才允许写回。被强制结束的一轮（超时、取消）留下的半截文件，因此不会把已登录的种子降级成冷启动状态。
- 只有在种子还不存在、需要从零创建时才固定 `privacyCache.ghostMode = true`；之后服务端写回的值原样保留，不再每轮改写。认证仍只通过进程内的 `CURSOR_AUTH_TOKEN`，不会把 token 写入这些文件。
- 模型列表（`/v1/models`）与对话轮次共用同一个并发闸门，且先取到名额再落盘：被判定过载的请求不会创建临时目录，也不会用过期快照覆盖别人刚写好的种子。

多实例部署共享同一个持久卷挂载为 `CURSOR_AGENT_STATE_DIR` 时，编译缓存与配置种子在实例间共享，而每个实例拥有各自的 CLI HOME，因此不会出现两个实例同时重写同一份技能同步目录。没有共享卷时，Cursor 请求在网络侧仍使用同一个共享账号，但每个实例会分别维护一份本地安装缓存。

固定版本 `2026.08.11-e8db854` 的 `-p/--print` 路径没有可用的会话环境变量：`CURSOR_CONVERSATION_ID` 只被传给 Agent 发起的 shell 工具执行，不会选择 CLI chat id；`CURSOR_AGENT_CHAT_ID` 只出现在 shell-integration 脚本中，并通过显式 `agent --resume <chatId>` 生效。

但同一版本的隐藏根选项 `--new-session-id <uuid>` 在 print 模式下有效（2026-08-18 实测：`-p --new-session-id <uuid> --output-format stream-json` 输出的每一行 `session_id` 都等于传入值，退出码 0；随后 `-p --resume <同一 uuid>` 能接上上一轮的上下文；在同一个配置目录里第二次使用同一个 id 会以 `Session ID "…" is already in use.` 失败）。因此运行时会为每个 AIHub 会话派生一个稳定的 UUIDv4（`sha256('aihub-cursor-chat:' + installationId + ':' + 会话键)`），经私有请求头 `x-aihub-conversation` 交给传输层，传输层校验形状后只作为 `--new-session-id` 参数传给 CLI，绝不写进子进程环境变量。轮次配置目录依然每轮重建，所以本地不会累积聊天记录，也不会触发上述 id 冲突；缺少安装身份或格式非法时直接不带该参数，由 CLI 自行生成 id（与之前行为一致）。

同理，当前 `-p` 请求没有发送可由 AIHub 控制的设备 id。管理后台刷新浏览器指纹会轮换共享 `installationId` 和 Grok agent id，但不会伪造 Cursor 的硬件哈希，也不会把清空本地缓存误称为 “新 Cursor 设备”。若未来固定版本在 `-p` 路径发送或接受设备身份，应把它接到同一 `installationId` 生命周期后再启用。

### Docker 机器标识

Cursor CLI 在运行时按 “第一个非黑名单 MAC → hostname” 计算机器哈希；Docker 中没有 `ioreg`。本地 `-p` 路径当前不会发送 `x-cursor-checksum`，但 Statsig 或 worker 模式可能消费该值。生产部署应在 Compose / 编排器中为容器固定 `hostname` 与 `mac_address`，避免重启时无意轮换；不要伪造 `x-cursor-checksum`。`docker-compose/enhanced/docker-compose.yml` 在应用服务旁保留了相应注释示例，多副本部署必须为同时在线的容器使用不冲突的 MAC。

每一轮在入队 / 落盘之前还会拒绝过大的请求：原始 body 上限 32 MiB，`history.messages` 最多 400 条、合计文本最多 40 万字符，图片最多 4 张、每张解码后 6 MiB，prompt 最多 20 万字符。

**公平性 HANDOFF：** 传输层拿不到可信的用户身份，不能在这里做 per-user 并发 / 排队公平。不要用客户端传来的 `userId` 头。应在 ModelRuntime 注入 `fetch` 的那一层传入服务端已认证的用户 id，再按用户限流。见 `apps/server/src/enterprise/services/cursorAgent/transport.ts` 的 `TODO(HANDOFF)`。

CLI 找不到时，连通性检查归类为 `cli_unavailable` → `connection_failed_transport`（部署问题，不是模型拒答）。

## 4. ToS

把个人 Cursor 账号挂成全员共享通道，可能违反 Cursor 的使用条款。生产环境请用 **Team / Enterprise 计划下的服务账号 API Key**。
