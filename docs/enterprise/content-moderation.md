# 内容审计（Content Moderation）设计

> 2026-08-17 定稿。参照 [sub2api](https://github.com/Wei-Shaw/sub2api) 的「内容审核 / 风控中心」重新设计，并补上它没有的**降级**处置、按类别配动作、按用户豁免、统计图表。
> 本文是实施前的设计基线；实施后以代码为准，并同步更新 `reference/` 下的表 / 权限 /tRPC 清单。

## 0. 一句话

用户每次把提示词发给模型之前，服务端先做一次内容审计：**关键词规则 → 决策缓存（哈希）→ 分类器（平台托管 LLM 裁判 或 OpenAI Moderations 兼容端点）**，按命中类别的配置执行 **忽略 / 仅记录 / 降级 / 阻断**；阻断时用户在助理消息位置看到管理员配置的提示文案，降级时自动改用管理员指定的降级模型并在该条回复上方持久化显示提示条。管理面板「审计 → 内容审计」提供 **概况（状态 + 图表）/ 违规记录（列表 + 详情抽屉）/ 设置** 三个 Tab。

## 1. 与 sub2api 的对照（照搬 / 改进 / 放弃）

| sub2api                                          | 本设计                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 关键词 Aho-Corasick → 命中哈希 → Moderations API | **照搬分层顺序**；哈希层升级为「决策缓存」（缓存的是判定结果，可回放降级 / 阻断）                |
| 全局单一处置 `off / observe / pre_block`         | 全局模式 `off / observe / enforce` + **每个类别独立动作**（忽略 / 仅记录 / 降级 / 阻断）         |
| 无降级                                           | **新增降级**：全局一个降级模型（服务商 + 模型），支持跨服务商                                    |
| OpenAI 13 类阈值                                 | 平台统一 **10 类**，Moderations 类别固定映射进来；LLM 裁判直接按 10 类输出                       |
| 分组 + 模型范围                                  | **豁免角色 + 豁免用户 + 模型包含 / 排除 + 请求类型**                                             |
| fail-open 固定                                   | 分类器异常策略可配：默认放行并记录异常，可切阻断                                                 |
| 自动封号（默认开）                               | 自动封禁可选（默认关），复用现有用户封禁；解封后从解封时刻重新计数                               |
| 存 240 字脱敏摘要                                | 默认脱敏摘要 ≤500 字 + 哈希；可选保存完整原文，查看需「显示原文」并写操作日志                    |
| 无 Tab、无图表、只有实时计数                     | 三 Tab；趋势面积图 / 类别分布 / 违规用户排行 / 命中来源 / 平均耗时；小时级聚合表保证放行量也可画 |
| 只审最后一条 user 消息、一张图                   | 只审本轮用户新输入的**文本**（图片二期）；同一轮工具循环按哈希去重不重复审                       |
| 进程内队列、重启即丢                             | 记录写入 fire-and-forget（Node 事件循环内），失败只打日志；无队列                                |

## 2. 术语与枚举

```ts
// 全局模式
type ModerationMode = 'off' | 'observe' | 'enforce';
// 类别（平台统一 10 类，key 稳定，展示名走 i18n）
type ModerationCategory =
  | 'sexual' // 色情
  | 'sexual_minors' // 涉未成年
  | 'violence' // 暴力与血腥
  | 'hate_harassment' // 仇恨与骚扰
  | 'self_harm' // 自杀自残
  | 'illicit' // 违法犯罪
  | 'political' // 政治敏感
  | 'jailbreak' // 越狱与提示注入
  | 'privacy' // 隐私与个人信息
  | 'other'; // 其他违规
// 类别动作（策略层）
type CategoryAction = 'ignore' | 'log' | 'downgrade' | 'block';
// 记录里的有效处置（运行层）
type EffectiveAction = 'allow' | 'log' | 'downgrade' | 'block' | 'error';
// 命中来源
type DecisionSource = 'keyword' | 'cache' | 'llm_judge' | 'moderations_api' | 'none';
// 请求类型
type RequestKind = 'chat' | 'image' | 'video';
// 分类器类型
type ClassifierKind = 'none' | 'llm_judge' | 'moderations_api';
```

动作严厉度：`ignore < log < downgrade < block`。多类别同时命中取**最严厉**。
`observe` 模式下：`policyAction` 照算并落库，`effectiveAction` 恒为 `allow`（或 `error`），用于上线前观察误报率。

OpenAI Moderations 13 类 → 10 类固定映射：`sexual→sexual`，`sexual/minors→sexual_minors`，`violence, violence/graphic→violence`，`hate, hate/threatening, harassment, harassment/threatening→hate_harassment`，`self-harm, self-harm/intent, self-harm/instructions→self_harm`，`illicit, illicit/violent→illicit`。同一目标类别取最大分数。`political / jailbreak / privacy` 仅 LLM 裁判与关键词能给出。

## 3. 运行时流程

### 3.1 拦截点

`apps/server/src/modules/ModelRuntime/index.ts:initModelRuntimeFromDB` 是所有服务端 LLM 调用的汇聚点（≈30 个调用方：webapi chat、AgentRuntime `ServerLLMTransport`、异步图像 / 视频、lambda 路由…）。企业侧通过既有 **注册桥**（`platformAiRuntimeBridge.ts` → `registerPlatformAiRuntime`）挂入，非企业代码只加一个可选桥方法：

```ts
// platformAiRuntimeBridge.ts（非企业侧，新增可选方法）
wrapModelRuntime?: (runtime: ModelRuntime, ctx: { db; userId; provider; workspaceId? }) => ModelRuntime;
```

`initModelRuntimeFromDB` 在返回前调用 `bridge.wrapModelRuntime?.(runtime, ctx) ?? runtime`。企业实现返回一个 **ModerationAwareRuntime**（Proxy / 委托对象，其他方法透传）：

- `chat(payload, options)`：
  1. 快照读取（§3.4）；`mode === 'off'` 或用户被豁免或模型 / 请求类型不在范围 → 直接透传（**不记录**）。
  2. 提取待审文本：`payload.messages` 中**最后一条 `role === 'user'`** 的文本内容（string 或 parts 中 `type: 'text'` 拼接），去除 `<system-reminder>` 块，归一化空白，截断 12000 字符。空文本 → 透传不记录。
  3. `sha256(normalizedText)`；同一 `userId + hash` 在 **60s 内**已判定过（进程内 LRU，5000 条）→ 复用**原始判定**（分数 / 命中规则 / 来源 /recordId），按当前请求类型与当前策略重新折算动作（图像请求不会继承聊天的降级；60s 内改策略立即生效），标记 `reused=true`：不重复审、不重复落库、不重复计数（覆盖工具循环 / 重试）。
  4. 依序：关键词匹配 → 决策缓存 → 分类器（§3.2）。得到 `{ categories: Record<category, score>, matchedRule?, source, latencyMs, error? }`。
  5. 由策略算 `policyAction`（§3.3）。`observe` → `effectiveAction = 'allow'`。
  6. `block`：抛 `PlatformBusinessError(PLATFORM_CONTENT_MODERATION_BLOCKED, { message: 阻断文案, category, recordId })`；webapi 路由映射为 **403**（加入 `PLATFORM_FORBIDDEN_ERROR_CODES`），客户端错误卡片渲染本地化文案 + 管理员文案。
  7. `downgrade`：目标 = 设置里的 `{ provider, model }`。若与当前相同 → 视为无需降级（`effectiveAction = 'log'`）。同服务商 → 改写 `payload.model`；跨服务商 → `initModelRuntimeFromDB(db, userId, targetProvider)`（内部标记 `skipModeration` 防递归）后委托 `chat`。返回的 `Response` 追加响应头 `X-Lobe-Moderation: downgrade`、`X-Lobe-Moderation-Provider`、`X-Lobe-Moderation-Model`、`X-Lobe-Moderation-Category`、`X-Lobe-Moderation-Record`（用 `new Response(res.body, { headers })` 重包）。
  8. `log / allow`：透传。
  9. 记录落库（§4.2）+ 小时聚合 +1（§4.3）+ 自动封禁检查（§3.5）—— **全部 fire-and-forget**，绝不阻塞用户请求；异常只打日志。
- `createImage / createVideo`：同上，审 `prompt`；`downgrade` 对非聊天请求**等同于 `block`**（设置页说明文字写明）。
- 其他方法（embeddings /tts/transcribe/generateObject/models…）透传。

> 已知盲区：BYOK 服务商开了 `fetchOnClient`（浏览器直连）时不经过服务端，无法审计。平台托管接管时服务端强制 `fetchOnClient:false`；概况页对「已发布且 fetchOnClient=true」的托管服务商给出黄色警告。

### 3.2 三层判定

1. **关键词层**（本地，永远可用）：规则 `{ id, pattern, isRegex, category, action, note, enabled }`，≤10000 条，`pattern` ≤200 字符；非正则按大小写不敏感子串（≤500 条一组编译为交替正则，特殊字符转义），正则按 `u` + `i` 标志；**正则规则的隔离**：字面量规则同步执行；正则规则一律在 `worker_threads` 工作线程（内联 `eval` 脚本，1 个懒创建的 worker，超时即 `terminate()` 并重建）里执行 —— 保存 / 试跑时先做静态检查 `assessRegexSafety`（递归检查分组体：嵌套量词、量词化分组含交替 / 通配 / 类转义、>2 个无界量词、`{n,m}` m>200、量词化反向引用、带量词的后行断言），再对**变更过的**正则（单次 ≤500 条）在 worker 中用按模式派生的 4000 字符对抗样本探测（200ms 预算），失败即 `PLATFORM_CONFIG_VALIDATION_FAILED { field:'keywords', index, reason: regex_unsafe | regex_slow | too_many_regex_changes }` 拒绝入库；运行时匹配也走 worker（50ms 预算，超时则本次跳过正则层并将该规则集熔断 60s），事件循环永远不会被管理员正则卡住。多条命中时按 **有效动作 = max (规则动作，类别动作)** 取最严者：`categories[rule.category] = 1`，`source = 'keyword'`，`matchedRule = { id, pattern, isRegex }`。关键词命中不再调分类器。
2. **决策缓存层**：表 `platform_content_moderation_decisions`，键 `hash`（`sha256(normalizedText)`），值 `{ categories, source, expiresAt, hitCount }`。只缓存 \*\* 分类器判定过且命中（policyAction ≠ ignore）\*\* 的结果；TTL 可配（默认 24h，0 = 关闭）。命中缓存 → `source='cache'`，回放类别后重新按当前策略算动作（策略改了立即生效）。
3. **分类器层**（`classifier.kind`）：
   - `llm_judge`：`{ provider, model, extraGuidance }`，从平台托管已发布模型中选。走平台托管路径（平台凭据、已发布模型白名单 / 追踪 / 用量 / 鉴权失败钩子与 `initModelRuntimeFromDB` 托管分支一致，无 BYOK 回退，不再包审计层防递归）；`generateObject`/`chat` + JSON 模式，内置系统提示（10 类定义 + 输出 `{"scores":{"sexual":0.0,...}}`，0–1）；`extraGuidance` 追加到系统提示末尾。`temperature 0`，`maxTokens 256`，输入截断 4000 字符。
   - `moderations_api`：`{ baseUrl, model, apiKeys[] (加密存储, 掩码回显), timeoutMs, retryCount }`；`POST {baseUrl}/v1/moderations`，key 池轮询 + 简单冷冻（401/403 10min，429 1min）；返回 `category_scores` 按 §2 映射。
   - 通用：`timeoutMs` 默认 3000（≤30000），`retryCount` 默认 1（≤5），`sampleRate` 默认 100（按 `hash` 确定性采样，非随机）。
   - 失败策略 `onError: 'allow' | 'block'`，默认 `allow`：分类器异常（超时 / 网络 / **响应格式非法** —— 缺类别、非有限分数一律视为异常，绝不按 0 分放行）一律记录为 `effectiveAction='error'`；`block` 策略下额外置 `enforce=true`（记录列 `enforced`）让运行时向用户返回阻断，但**不计入违规 / 自动封禁**，健康度按 `error IS NULL` 统计（最近 100 次成功率 / 平均耗时）。

### 3.3 策略计算

```
for each category with score >= thresholds[category]  → candidate = categoryActions[category]
keyword hit → candidate = max(rule.action, categoryActions[rule.category])
policyAction = max(candidates) ?? 'ignore'
```

默认阈值（对齐 sub2api 的保守值再折中）：`sexual .65, sexual_minors .50, violence .90, hate_harassment .80, self_harm .65, illicit .90, political .70, jailbreak .75, privacy .80, other .95`。
默认动作：`sexual_minors: block`，`sexual / self_harm / illicit / political: block`，`jailbreak: downgrade`，`violence / hate_harassment / privacy: log`，`other: ignore`。设置页提供「恢复默认」。

### 3.4 配置快照与热路径

- 设置单行表 `platform_content_moderation_settings`（§4.1），读侧走既有 `DomainConfigCache`（TTL 30s，Redis scope-epoch 失效；写入后本实例同步 `reset`）。快照里附带按配置 digest 编译好的关键词匹配器与豁免集合，digest 不变不重编译。
- 用户角色 / 豁免判断：`userId → roles` 走同一快照周期的进程内 memo（30s）。
- 热路径零额外 DB 读（缓存命中时）；决策缓存查询一次主键读，可接受。

### 3.5 自动封禁（可选，默认关）

`autoBan: { enabled, threshold=10, windowDays=30, duration: 'permanent' | { days } }`。计数 = 该用户窗口内 `effectiveAction ∈ (downgrade, block)` 且 `source ≠ 'cache'` 的记录数，且只统计**上一次自动封禁解封之后**的记录（`users.banned=false` 的时刻由 `platform_content_moderation_records.autoBanned=true` 最近一条 + 用户当前未封禁推得；简化：统计 `createdAt > max(createdAt where autoBanned)`）。达到阈值 → 复用 `admin.users.ban` 的模型层（`banned=true, banReason='内容审计：窗口内违规 N 次'`，定期封禁沿用现有 banUntil 机制），写操作日志 `content_moderation.user.auto_ban`（actor=system），并在触发记录上标 `autoBanned=true`。豁免角色永不自动封禁。

### 3.6 用户侧呈现

- **阻断**：`packages/const/src/platform/errorCodes.ts` 新增 `PLATFORM_CONTENT_MODERATION_BLOCKED`；`packages/locales/src/default/error.ts` `response.PLATFORM_CONTENT_MODERATION_BLOCKED` 默认文案「该消息未通过内容审计，请调整后重试」；错误卡片优先显示 error body 里的管理员 `message`（设置项 `blockMessage`），下方小字显示类别名（`showCategoryToUser` 开关，默认开）。用户消息保留在会话中（已在 `sendMessageInServer` 落库），助理消息位置显示错误卡片，可重试。
- **降级**：`fetchSSE` `onFinish` 读上述响应头 → `createAgentExecutors` 把 `{ moderation: { action:'downgrade', originalModel, originalProvider, model, provider, category, recordId } }` 写进助理消息 `metadata`，并把消息的 `model/provider` 改为实际模型；`Assistant/Extra` 新增 `ModerationNotice`（`metadata.moderation` 存在时渲染），文案 `chat.moderation.downgraded`「该消息因内容审计已改用 {{model}} 回复」，管理员可覆盖（设置项 `downgradeMessage`，支持 `{{model}}` 占位）。AgentRuntime（服务端驱动）路径由服务端在 `onChatFinal` 直接写 `messages.metadata`。
- `observe` 模式用户无感。
- 管理员的降级文案（`messages.downgradeMessage`，支持 `{{model}}`）非空时经响应头 `x-lobe-moderation-message`（`encodeURIComponent`）/ `metadata.moderation.message` 下发，客户端本地替换占位符后按纯文本渲染；为空则用本地化默认文案。阻断文案为空时错误体不带 `message`，客户端用本地化默认文案。默认配置两者均为空字符串。
- **B2 ↔ B5 契约**：阻断错误经 `createErrorResponse(PLATFORM_CONTENT_MODERATION_BLOCKED, body)` 返回，`body = { message?: string; category?: ModerationCategory; recordId?: string }`（`message` 为管理员配置的阻断文案，`category` 仅在 `showCategoryToUser` 时给出）；客户端从 `message.error.body` 读取。降级响应头见 `MODERATION_HEADERS`（`packages/const/src/platform/contentModeration.ts`），助理消息 `metadata.moderation` 形状见 `MessageModerationMetadataSchema`（`packages/types/src/message/common/metadata.ts`）。类别显示名统一放在 `common` 命名空间 `moderation.category.<key>`，聊天卡片与管理面板共用。

## 4. 数据模型

迁移 `packages/database/migrations/0016_content_moderation.sql`（`when` > 1787000000000）。

### 4.1 `platform_content_moderation_settings`（单行）

| 列                        | 类型        | 说明                              |
| ------------------------- | ----------- | --------------------------------- |
| id                        | text PK     | 固定 `'default'`                  |
| config                    | jsonb       | `ContentModerationConfig`（下）   |
| revision                  | integer     | CAS，`PLATFORM_REVISION_CONFLICT` |
| updated\_by               | text        |                                   |
| created\_at / updated\_at | timestamptz |                                   |

```ts
interface ContentModerationConfig {
  mode: ModerationMode; // off
  requestKinds: RequestKind[]; // ['chat','image','video']
  scope: {
    exemptRoles: string[]; // ['super_admin','admin']
    exemptUserIds: string[];
    modelFilter: { type: 'all' | 'include' | 'exclude'; models: string[] }; // 'provider/model'
    sampleRate: number; // 100
  };
  categories: Record<ModerationCategory, { action: CategoryAction; threshold: number }>;
  keywords: KeywordRule[];
  classifier: {
    kind: ClassifierKind; // 'none'
    llmJudge?: { provider: string; model: string; extraGuidance?: string };
    moderationsApi?: { baseUrl: string; model: string; apiKeyRefs: string[] }; // 密文引用
    timeoutMs: number;
    retryCount: number;
    onError: 'allow' | 'block';
  };
  decisionCache: { enabled: boolean; ttlHours: number }; // true, 24
  downgrade: { provider: string; model: string } | null;
  messages: { blockMessage: string; downgradeMessage: string; showCategoryToUser: boolean };
  autoBan: { enabled: boolean; threshold: number; windowDays: number; durationDays: number | null };
  records: {
    recordNonHits: boolean;
    storeFullPrompt: boolean;
    hitRetentionDays: number;
    nonHitRetentionDays: number;
  }; // false,false,180,3(≤3)
  notify: { enabled: boolean; emails: string[]; onActions: EffectiveAction[] }; // false, [], ['block']
}
```

Moderations API 密钥：明文只在写入时出现，落库前用既有平台密钥封装（与全局凭据 `platform_global_credentials` 同一机制）；读侧回显 `sk-…ab12` 掩码 + `hasKey`。

### 4.2 `platform_content_moderation_records`

| 列                                     | 类型                      | 说明                                                                   |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| id                                     | text PK (uuid)            |                                                                        |
| created\_at                            | timestamptz               |                                                                        |
| user\_id                               | text, SET NULL            | → users                                                                |
| user\_snapshot                         | jsonb                     | `{ email, username, fullName }` 冗余，用户删除后仍可读                 |
| request\_kind                          | text                      | chat/image/video                                                       |
| request\_id                            | text                      | trace/request id（若有）                                               |
| topic\_id / message\_id                | text nullable             | 聊天路径可用时填（AgentRuntime 路径有）                                |
| provider / model                       | text                      | 用户请求的模型                                                         |
| effective\_provider / effective\_model | text nullable             | 降级后的实际模型                                                       |
| policy\_action                         | text                      | ignore/log/downgrade/block                                             |
| effective\_action                      | text                      | allow/log/downgrade/block/error                                        |
| enforced                               | boolean                   | `error` 且 `onError=block` 时为 true（用户被阻断但不计违规）           |
| source                                 | text                      | keyword/cache/llm\_judge/moderations\_api/none                         |
| top\_category                          | text nullable             |                                                                        |
| top\_score                             | numeric(6,4)              |                                                                        |
| category\_scores                       | jsonb                     | `Record<category, score>`                                              |
| threshold\_snapshot                    | jsonb                     | 判定时的 `{category: {action, threshold}}`（sub2api 同款，事后可解释） |
| matched\_rule                          | jsonb nullable            | `{ id, pattern, isRegex }`                                             |
| prompt\_hash                           | text                      | sha256                                                                 |
| prompt\_excerpt                        | text                      | 脱敏后 ≤500 字                                                         |
| prompt\_full                           | text nullable             | 仅 `storeFullPrompt` 开启时；同样先做密钥类脱敏                        |
| classifier\_latency\_ms                | integer nullable          |                                                                        |
| error                                  | text nullable             |                                                                        |
| violation\_count                       | integer                   | 判定时该用户窗口内累计（含本条）                                       |
| auto\_banned                           | boolean                   |                                                                        |
| notified                               | boolean                   |                                                                        |
| revealed\_at / revealed\_by            | timestamptz/text nullable | 最近一次「显示原文」                                                   |

索引：`(created_at desc)`、`(user_id, created_at desc)`、`(effective_action, created_at desc)`、`(top_category, created_at desc)`、`(prompt_hash)`。
脱敏正则（存摘要与原文都用）：URL、`key/token/password/secret=…`、`Bearer …`、JWT、`sk-…`、32+ hex、48+ base64、UUID、11 位手机号、18 位身份证 → `[已脱敏]`。
保留：`hitRetentionDays`（默认 180，≤3650）对 `policy_action ≠ ignore` 或 `effective_action='error'`；`nonHitRetentionDays`（默认 3，硬上限 3）对其余。清理为**机会式**：每次落库后若本实例距上次清理 > 1h 则异步 `DELETE … LIMIT 5000`。

### 4.3 `platform_content_moderation_hourly_stats`（聚合，保证放行量可画）

`(bucket_start timestamptz, request_kind, effective_action, policy_action, source, top_category nullable, count int, latency_sum_ms bigint, latency_count int)`，主键为前 6 列（`top_category` 用 `''` 代 null）。每次判定 `INSERT … ON CONFLICT DO UPDATE SET count = count + 1, …`。保留 400 天。趋势图 / 类别分布 / 命中来源 / 平均耗时全部由该表出；**违规用户排行**从记录表出（只涉及命中）。

### 4.4 `platform_content_moderation_decisions`（决策缓存）

`(prompt_hash text PK, categories jsonb, source text, hit_count int, created_at, last_hit_at, expires_at)`；读时 `expires_at > now()`；「清空缓存」= `DELETE`。

## 5. 权限、审计、注册表

- 新权限：`MODERATION_READ = 'platform_moderation:read:all'`、`MODERATION_MANAGE = 'platform_moderation:manage:all'`。角色包：`super_admin` 全部；`auditor` 加 `MODERATION_READ`；`ai_admin` 加 `MODERATION_READ + MODERATION_MANAGE`；其他不变。**现有部署需重新播种**（bootstrap CLI）。
- 操作日志动作（`auditActionCatalog.ts` + en/zh 标签，locale 测试强制）：`content_moderation.settings.update`、`content_moderation.classifier.test`、`content_moderation.record.reveal`、`content_moderation.records.delete`、`content_moderation.cache.clear`、`content_moderation.user.auto_ban`。目标类型：`content_moderation_settings`、`content_moderation_record`、`user`。
- tRPC `admin.contentModeration.*`（`apps/server/src/enterprise/routers/admin/contentModeration.ts`，登记到 `admin.ts`、授权注册表、变更注册表；计数测试 187/90/97 → **197/95/102**）：

| procedure          | 类型 | 权限   | 说明                                                                                                                                                                                                              |
| ------------------ | ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| getSettings        | Q    | READ   | `{ settings, catalog, roles }`：配置 + revision + 密钥掩码 / 指纹、平台托管已发布模型目录（降级 / 裁判选择器）、系统角色列表                                                                                      |
| getOverview        | Q    | READ   | 状态卡：模式、分类器类型 / 健康度（最近 100 次成功率、平均耗时）、关键词数、缓存条数、降级模型、自动封禁、fetchOnClient 警告                                                                                      |
| getStats           | Q    | READ   | 入参 `{ from, to, timezone }`（≤400 天）→ 趋势序列（≤3 天按小时，否则按天）、KPI、类别分布、来源分布、Top10 用户、平均耗时                                                                                        |
| listRecords        | Q    | READ   | offset 分页 + `{ actions[], categories[], sources[], kinds[], userQuery, search, from, to }`；`prompt_full` 不返回                                                                                                |
| getRecord          | Q    | READ   | 单条详情（不含 `prompt_full`，只给 `hasFullPrompt`）                                                                                                                                                              |
| updateSettings     | M    | MANAGE | CAS `expectedRevision`；校验（正则可编译、阈值 0–1、降级模型必须已发布、nonHit ≤ 3）；写操作日志同事务；成功后失效缓存                                                                                            |
| testClassifier     | M    | MANAGE | 传入文本（≤4000）+ 当前表单配置（不落库、不写缓存、隔离 key 健康池、8s 硬超时、错误只回有限码）→ 各类别分数、命中规则、拟处置、耗时；同样校验目录归属；**已保存密钥仅可用于已保存的 baseUrl，端点变更须重录密钥** |
| revealRecordPrompt | M    | MANAGE | 返回 `prompt_full`，写 `content_moderation.record.reveal` + `revealed_at/by`                                                                                                                                      |
| deleteRecords      | M    | MANAGE | 按 id 列表删除（≤200），写操作日志                                                                                                                                                                                |
| clearDecisionCache | M    | MANAGE | 清空 §4.4，写操作日志                                                                                                                                                                                             |

## 6. 管理面板

路由 `/admin/audit/content-moderation`（`审计` 组，紧随「会话历史」之后，label `内容审计`，图标 `ShieldAlert`），`?tab=overview|records|settings`。三个 Tab 都要求 `MODERATION_READ`；设置 Tab 里的保存 / 测试、记录页的删除 / 显示原文、概况页的清缓存按钮由 `MODERATION_MANAGE` 门控（无权限时禁用 + tooltip）。

### 6.1 概况

- 顶部状态卡（等高栅格，复用系统页基础设施卡样式）：**运行模式**（关闭 / 观察 / 生效 + 一键跳设置）、**分类器**（类型 + 模型 / 端点 + 健康度 pill：正常 / 波动 / 异常 / 未启用）、**规则**（关键词 N 条・缓存 N 条・「清空缓存」）、**降级模型**（provider/model 或「未配置 → 降级动作将退化为阻断」警告）、**自动封禁**（关 / 阈值 N 次・窗口 N 天）。
- fetchOnClient 盲区 → 页面顶部 `Alert(warning)`。
- 时间范围筛选（复用 `TimeRangeFilter`，默认近 7 天）+ KPI 行：审计次数 / 放行 / 仅记录 / 降级 / 阻断 / 异常 / 平均耗时。
- 图表（`@lobehub/charts`）：**趋势**（`AreaChart` 堆叠：放行・仅记录・降级・阻断・异常）、**类别分布**（`BarChart`，命中记录按 `top_category`）、**违规用户 Top10**（`BarList`，点击 → 记录 Tab 带 `userId` 筛选）、**命中来源**（`BarList`：关键词 / 缓存 / LLM 裁判 / Moderations）、**请求类型**（chat/image/video）。观察模式下额外一行「拟处置」KPI（拟降级 / 拟阻断）。

### 6.2 违规记录

- `DataTable`（offset 分页 20/50/100，工具栏左：搜索框「用户 / 请求 ID / 摘要」，右：批量删除）。列：时间・用户（头像 + 邮箱，点击 → 用户管理）・处置（tag：阻断 red / 降级 orange / 仅记录 gold / 放行 default / 异常 volcano；观察模式记录处置旁灰字「拟阻断」）・类别・分数・来源・请求类型・模型（`原 → 实际`）・耗时・摘要（单行省略）。
- 列头筛选：处置（enum）・类别（enum）・来源（enum）・请求类型（enum）・时间（range）・用户（search）。默认筛选 `policyAction ≠ ignore`（有「显示放行记录」开关，仅在 `recordNonHits` 开启时有意义）。
- 行点击 → **详情抽屉**：`基本信息`（时间 / 用户 / 请求 ID / 会话与话题 / 请求类型 / 原模型 / 实际模型）；`判定`（处置 + 拟处置、命中来源、匹配规则、各类别 **分数 vs 阈值快照 横条**（sub2api「试跑」同款可视化）、分类器耗时、错误）；`内容`（脱敏摘要；若 `hasFullPrompt`：折叠区 + 「显示原文」按钮 → 二次确认 → 调 `revealRecordPrompt`）；`处置`（用户窗口内违规次数、是否触发自动封禁、是否已通知；快捷操作：封禁 / 解封（复用用户管理的弹窗与权限）、删除记录）。

### 6.3 设置

分区表单（直接生效，无草稿；右上角「保存」，CAS 冲突提示刷新；每个分区标题带一句说明）：

1. **基础**：模式（关闭 / 观察 / 生效，切到生效时二次确认）・请求类型多选・阻断提示文案・降级提示文案（`{{model}}`）・向用户显示类别（开关）・**降级模型**（服务商 + 模型级联选择，数据源 = 平台托管已发布模型；空则提示降级退化为阻断）。
2. **适用范围**：豁免角色（多选，默认 super\_admin/admin）・豁免用户（搜索添加，复用 `admin.users.list` 的身份搜索）・模型范围（全部 / 仅包含 / 排除 + 模型多选）・采样率。
3. **分类器**：类型单选（不使用 / 平台托管模型裁判 / OpenAI Moderations 兼容端点）→ 对应子表单；超时 / 重试 / 异常时策略；**「测试」**：输入文本 → 结果面板（分数条 + 命中规则 + 拟处置 + 耗时）。
4. **类别与动作**：10 行表格：类别（中文名 + 一句定义 tooltip）・动作 Select・阈值（0–1，步长 0.05）；「恢复默认」。
5. **关键词规则**：表格（关键词 / 正则・正则开关・类别・动作・备注・启用・删除）+ 「添加」+ 「批量导入」（每行一条，`关键词[\t类别[\t动作]]`）+ 计数（N/10000）+ 正则编译错误行内提示。
6. **决策缓存**：启用・TTL 小时・「清空缓存」。
7. **自动封禁**：启用（默认关，开启二次确认）・阈值・窗口天数・封禁时长（永久 / N 天）。
8. **记录与保留**：记录放行请求（开关，警示磁盘增长）・保存完整原文（开关，警示隐私）・命中保留天数・未命中保留天数（≤3）・通知（启用・收件邮箱列表・触发动作多选；每用户每小时最多 1 封）。

## 7. 实施批次（每批一 commit，grok 编码 /codex 复审）

| 批  | 内容                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | 类型 / 常量 / 权限码 / 错误码 + 迁移 0016 + schemas + models（settings CAS、records、hourly\_stats、decisions）+ 脱敏与规范化工具 + 关键词匹配器 + 策略计算 + 决策服务（含 LLM 裁判 / Moderations 客户端）+ 单测 |
| B2  | 运行时拦截：桥方法 `wrapModelRuntime` + `ModerationAwareRuntime`（chat/image/video、跨服务商降级、响应头）+ 阻断错误码映射 403 + 记录 / 聚合 / 自动封禁 / 通知的异步落库 + 机会式清理 + 集成测试                 |
| B3  | 服务端 tRPC 路由 10 个 + 注册表（197/95/102）+ 操作日志动作 / 目标 + locale 标签 + 路由测试                                                                                                                      |
| B4  | 管理面板：导航项 + 路由（两份 router 配置）+ 三 Tab 页面 + 详情抽屉 + 图表 + 设置表单 + zh-CN/en-US 文案 + 页面测试                                                                                              |
| B5  | 用户侧：错误卡片文案、`fetchSSE` 响应头 → 助理消息 metadata、`ModerationNotice` 提示条、AgentRuntime 路径服务端写 metadata + 测试                                                                                |
| B6  | 文档（本文校订 + `reference/` 三个清单）+ `bun run i18n` + demo 重播种权限 + Docker 上线                                                                                                                         |

## 8. 明确不做（本期）

- 附件图片的多模态审计；工具结果 / 系统提示词审计；模型输出（响应）审计。
- 分组级策略、按用户不同阈值。
- 记录导出（可后续接入既有审计导出）。
- 分布式队列；多实例下小时聚合表靠 `ON CONFLICT` 累加天然安全，决策缓存 / 设置快照靠 TTL 收敛。
