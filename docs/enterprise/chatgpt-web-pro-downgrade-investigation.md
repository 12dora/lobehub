# ChatGPT Web Pro 被服务为 mini：2026-08-19 调查记录

> 状态：暂停上游验证。当前账号的真实 Chrome 也已开始把 Pro 请求服务为 mini，说明账号 / 设备进入了风控状态。从这一时点开始，任何 mini 结果都不能再用于判断 AIHub 的协议差异。

## 当前结论

尚未得到可宣称为 “最终根因” 的单一差异，也尚未在干净账号状态下证明工作区修复已经恢复 Pro。

已经确认两类真实实现问题：

1. 已提交的 `bb19f8f225` 修复了浏览器不可能产生的 `system` 角色消息，并恢复了真实 `model_slug` 的观测。
2. 当前工作区修复了 `conduit_token: null` 被误判为 prepare 失败、错误回落旧接口的问题，并将 Pro 默认的 `thinking_effort` 对齐为 `standard`。

本轮又确认了一个此前遗漏的协议时序差异：真实 Chrome 不等待 Pro 的两条 prepare 响应，而 AIHub 此前会 `await Promise.all(...)` 后再发送 conversation。工作区现已将 Pro prepare 改为非阻塞、仅观察结果，然后立即发送 conversation；相关单测通过。但该改动完成时真实 Chrome 已受风控污染，因此现场 mini 结果不能验证或否定这项修复。

## 干净基线与时间线

### 可信的干净基线

用户提供的真实 Chrome HAR 中，2026-08-19 07:34:08Z 的同账号请求：

- 请求模型：`gpt-5-6-pro`
- 最终响应真实 `model_slug`：`gpt-5-6-pro`
- 两条 `/backend-api/f/conversation/prepare` 均返回：

  ```json
  { "conduit_token": null, "status": "ok" }
  ```

这证明 null conduit token 本身不是降级信号，也不是浏览器回落旧接口的条件。

### 后续现场结果

| 阶段                                                                                   | 结果                                    | 可否用于归因                                  |
| -------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| 原始 Chrome HAR（07:34Z）                                                              | Pro 请求得到 `gpt-5-6-pro`              | 可以，干净基线                                |
| 对齐 profile、当前 Chrome web session/access token/device ID 后的 AIHub 请求（09:07Z） | 得到 `gpt-5-5-mini`                     | 仅作记录；当时是否已开始风控无法确定          |
| Pro prepare 改为非阻塞后的 AIHub 请求（09:20Z）                                        | 请求时序已与 Chrome 一致，但仍得到 mini | 不可以；用户随后确认真实 Chrome 也已降为 mini |
| 当前真实 Chrome                                                                        | Pro 也被路由到 mini                     | 明确表明环境已受风控污染，停止测试            |

## HAR 证明的 Pro 请求时序

真实 Chrome 的三条请求并不是 prepare 握手完成后再发送：

| 请求                                     | 相对启动时间 | 响应完成耗时 |
| ---------------------------------------- | -----------: | -----------: |
| prepare，`client_prepare_state: success` |         0 ms |    1470.7 ms |
| prepare，`client_prepare_state: sent`    |        11 ms |    1504.9 ms |
| `/backend-api/f/conversation`            |        98 ms |    5732.6 ms |

因此 conversation 在两条 prepare 返回前约 1.37–1.41 秒就已开始。`conduit_token: null` 更不可能是该次 send 的输入，因为 send 发出时 token 响应尚未存在。

工作区实现已据此调整为：

1. 同一 turn identity 下启动 `success` 和 `sent` 两条 prepare；
2. 不等待它们完成；
3. 立即发送 `/backend-api/f/conversation`；
4. 后台消费 prepare 的成功 / 失败，避免未处理 Promise rejection；
5. 不使用迟到的 conduit token。

现场日志确认改动后的实际顺序为：

```text
09:20:15.183 prepare success 启动
09:20:15.187 prepare sent 启动
09:20:15.188 conversation 启动
09:20:15.717 / 09:20:15.893 prepare 返回 null
```

该时序修复本身有 HAR 证据支撑，但其是否解决 Pro 降级必须在风控恢复后验证。

## 请求形状对比

### 初始 Pro turn

原始 HAR 中两条 prepare 与当前 AIHub builder 已逐字段对齐：

- `model: gpt-5-6-pro`
- `thinking_effort: standard`
- `client_prepare_state: success`，随后 `sent`
- `client_prepare_dispatch: immediate`
- `client_prepare_source: context_change`
- `parent_message_id: client-created-root`
- `timezone: Asia/Singapore`
- `timezone_offset_min: -480`
- `conversation_mode.kind: primary_assistant`
- `system_hints: []`
- `supports_buffering: true`
- `supported_encodings: ["v1"]`
- `client_contextual_info.app_name: chatgpt.com`
- `local_function_names: ["local.continue_in_work"]`

HAR 的最终 `/f/conversation` body 也与当前 builder 的字段和值一致，包括：

- `client_prepare_state: sent`
- `parent_message_id: client-created-root`
- `thinking_effort: standard`
- `force_parallel_switch: auto`
- `paragen_cot_summary_display_override: allow`
- 1728×1117、DPR 2 对应的 contextual info
- rich message metadata、`supported_encodings`、`supports_buffering`

### 用户随后提供的 prepare cURL

该 cURL 是已有 conversation 中的编辑器 prepare，不是上述 “新 conversation 初始 Pro turn”：

- 带 `conversation_id`
- `client_prepare_dispatch: debounced`
- `client_prepare_source: composer_editor_state`
- 只有 `client_prepare_state: success`

因此这组值不能替换初始 Pro turn 的 `immediate/context_change + success/sent`。它证明的是另一种真实浏览器生命周期形状。

## 完整 cURL 分层验证结果

按用户要求，先从完整请求做控制组，再逐层改变 transport：

1. 完整 cURL 用 macOS 系统 curl 原样发送：HTTP 403。原因是仅复制 header/cookie 不会复制 Chrome TLS/HTTP2 指纹，尚未到模型路由阶段。
2. 同一请求换成项目固定的 `curl-impersonate chrome150`：本地二进制先因 Chrome 的整段 Cookie 参数超过单字段上限而退出，未发出请求。
3. 不删除任何 Cookie，只将相同 cookie 写入权限为 0600 的临时 Netscape jar，并让 impersonator 分拆 Cookie header：prepare 成功返回 HTTP 200、`status: ok`、`conduit_token: null`。
4. 将 HAR 中已知返回 Pro 的最终 conversation 原样重放，并补入当前 Chrome authorization/cookies：HTTP 403，返回 “Unusual activity has been detected”。该次使用的是 HAR 中已过时 / 可能已消费的 Sentinel proof，且账号随后确认已进入风控，所以该结果不能判断模型路由。

结论：ChatGPT Web 的控制请求必须使用 Chrome impersonation transport；系统 curl 的 403 不能拿来判断降级。Sentinel proof 不能跨 turn 重放。

## 已排除或已修复的假设

| 假设                                    | 状态                   | 依据                                                 |
| --------------------------------------- | ---------------------- | ---------------------------------------------------- |
| `system` 角色消息暴露自动化形状         | 已确认并修复           | commit `bb19f8f225`                                  |
| 真实 `model_slug` 被丢弃                | 已确认并修复           | commit `bb19f8f225`，服务端日志可判定实际模型        |
| `conduit_token: null` 表示 prepare 失败 | 已排除并修复           | Chrome Pro HAR 同样返回 null，且 send 已在响应前开始 |
| Pro 应发送 `thinking_effort: max`       | 已排除                 | HAR 明确为 `standard`                                |
| Pro 不需要 `thinking_effort`            | 已排除并修复           | HAR 明确携带 `standard`                              |
| prepare 必须完成后才可发送              | 已排除并修复工作区实现 | HAR 时序证明 send 与 prepare 并行                    |
| 仅缺少 `oai-telemetry` 导致降级         | 此前单独实测未改变结果 | 但当前后续环境已污染，不再追加请求                   |
| 单独由 IP / 地理位置造成                | 用户已排除             | 同机同 IP 的 Chrome 曾稳定获得 Pro                   |
| 账号配额耗尽                            | 用户已排除             | 账号行为与配额模型不符                               |

## 仍未隔离的差异

以下项目在干净风控状态恢复前不得下结论：

1. 完整 Chrome Cookie jar 与 AIHub 最小 jar 的差异，例如 Cloudflare/session/routing cookie。
2. `OAI-Session-Id` 的精确生命周期。AIHub 已从长期固定值改为进程生命周期 UUID，但还未证明是否应与页面会话绑定。
3. `oai-echo-logs`。HAR 中存在，AIHub 未伪造；旧 proof 的整体 HAR 重放因风控 403，未完成独立 A/B。
4. 当前 access token、web session、device ID 与风控画像的组合是否已经被标记。
5. prepare 非阻塞修复是否足以恢复 Pro。代码与时序已经对齐，但唯一现场验证发生在污染后。

## 当前工作区与本地状态

- HEAD：`44cb2bc2fc`
- 已提交相关修复：`bb19f8f225`
- ChatGPT Web 相关修复仍在工作区，未提交。
- 本地快速环境的 browser profile 已校准为 macOS / Asia-Singapore /zh-CN，profile revision 为 9。
- 当前 Chrome web session/access token 与相同 `oai-device-id` 已通过正式管理接口写入 demo 数据库，provider revision 为 25。
- Copy-as-cURL 的现有通用解析会保留 session/access token，但不会自动把 `oai-device-id` 贯穿到连接 envelope；本轮调试脚本显式保留了该 ID。这是独立的实现缺口，尚未产品化修复。
- 本轮添加的 Pro prepare 非阻塞实现位于：
  - `packages/model-runtime/src/providers/chatgptWeb/index.ts`
  - `packages/model-runtime/src/providers/chatgptWeb/index.test.ts`
- 单测：`index.test.ts` 共 76 项通过。
- 工作区还包含多项 HAR 对齐实验；并非每项都已证明与降级有关，提交前应逐项收敛，不应把所有实验一次性视为最终修复。

本地证据保存在：

```text
.records/reports/20260819-160908-chatgptweb-pro-downgrade/
```

其中包含各轮 SSE、headers、服务端日志、profile 摘要以及经过脱敏的 cURL/HAR 重放结果。凭据原文未写入报告。

## 风控恢复后的最小复测方案

前置条件：先由真实 Chrome 发起一次 Pro 请求，且响应真实 `model_slug` 恢复为 `gpt-5-6-pro`。在此之前不要继续 AIHub 上游测试。

恢复后严格控制请求次数：

1. 保存这一次 Chrome 成功 turn 的完整 HAR，必须同时包含两条 prepare 和最终 `/f/conversation`，不要只保存 prepare。
2. 不重放 HAR 中旧的 Sentinel token/proof；proof 必须由各自 turn 新生成。
3. 只发送一次当前工作区的 AIHub Pro 请求，优先验证 “非阻塞 prepare” 改动。
4. 若仍为 mini，再按一次只变一个变量的顺序测试：
   1. 完整 Chrome Cookie jar + 当前 Chrome `OAI-Session-Id`；
   2. 保持 Cookie/session ID，仅去掉 `oai-echo-logs`；
   3. 从完整 Cookie jar 逐步缩减到 AIHub 最小 jar；
   4. 最后才测试其他非关键 telemetry/header。
5. 每轮都以服务端观测的真实 `model_slug` 判定，不能使用模型自述。
6. 一旦真实 Chrome 再次变成 mini，立即停止；该轮及之后的数据全部标记为风控污染。

## 暂停点

当前最值得保留的代码候选是 “Pro prepare 非阻塞发送”，因为它由 HAR 时序直接证明。当前最需要避免的是继续向同一账号重复发送高度相似的 Pro/Sentinel 请求；这已经破坏了唯一可靠的 Chrome 对照组。
