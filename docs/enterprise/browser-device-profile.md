# 共享浏览器设备画像

AIHub 为需要模拟真实浏览器的服务维护一套平台级、合成的桌面 Chrome 画像。画像在一次安装中保持稳定，并由所有相关传输共享；它不读取宿主机的操作系统、屏幕、语言、时区或硬件信息，因此仓库和上游请求都不会意外携带管理员电脑的真实特征。

## 生成与一致性

同构模型位于 `packages/model-runtime/src/browserProfile/`，通过 `@lobechat/model-runtime/browserProfile` 导出。`generateBrowserDeviceProfile({ seed, preferences })` 只使用带种子的伪随机数生成器，同一个 seed 总会得到完全相同的 `schemaVersion: 1` 画像。

生成器把以下信息作为一组约束，而不是分别随机拼接：

- curl-impersonate v2.1.0 实际提供的 Chrome 目标（`chrome136`、`chrome142`、`chrome145`、`chrome146`、`chrome150`）与同主版本的 UA、`sec-ch-ua`、完整版本列表；
- macOS / Windows 的 UA 冻结规则、平台版本、架构、逻辑分辨率、DPR、CPU、内存和 WebGL 信息；
- Accept-Language、`navigator.languages`、OAI language、IANA 时区和该时区的标准偏移组成的地域包；
- DNT、明暗主题、减少动态效果、设备内存、CPU 核心数等浏览器偏好。

时区偏移与 Chrome 日期后缀在**每次请求时**按画像的 IANA 时区重新计算（`resolveProfileTimezone`），因此夏令时期间上报的偏移和时区名与真实浏览器一致；画像里存的标准时值只作为兜底。

`validateBrowserDeviceProfile(profile)` 会拒绝 Chrome 主版本与 impersonate 目标不符、UA-CH 不一致、平台 / 架构冲突、屏幕逻辑分辨率与 DPR 相乘得不到真实面板、屏幕或硬件组合不在受支持池中等情况。读取已持久化的画像时只做结构校验（`validateBrowserDeviceProfileShape`）：受支持池会随 Chrome 版本更替调整，已有安装必须继续使用它一直在上游呈现的身份，而不是因为池子变了就退回共享降级画像。

校验规则在功能首次发布前才收紧，因此早期开发版本写入的画像有可能被判为不可用并被重新生成一次（该功能尚未发布，线上不存在需要兼容的历史安装）。

`DEFAULT_BROWSER_DEVICE_PROFILE` 是固定 seed 生成的、与任何宿主机无关的降级画像，仅在存储不可用或同构调用方主动传入时使用。降级期间不会附带按连接持久化的 Cookie 罐 ——`cf_clearance` 与获取它的 UA 绑定，换一套 UA 重放正是会触发 Cloudflare 挑战的原因。

## 存储与生命周期

仓库没有适合这一类带修订号、需要 CAS 收敛的通用平台 KV 表，因此画像使用专用单行表 `platform_browser_profiles`（迁移 `0022_platform_browser_profile`）。表保存私有 seed、完整 JSON 画像、修订号、创建 / 更新时间与更新者；管理 API 只返回非敏感摘要，绝不返回 seed。

`PlatformBrowserProfileService.get()` 的首次读取流程是：

1. 生成随机 UUID 作为 seed；
2. 校验生成结果；
3. `INSERT ... ON CONFLICT DO NOTHING` 写入固定主键 `default`；
4. 若另一个实例抢先写入，重新读取胜出的行。

若读到的画像已经不是一个可用的画像对象（截断的 JSON、与 seed 列不一致等），服务会在同一个事务里重新生成、写入并递增 revision，同时记一条审计（原因 `profile migrated`）。

因此并发启动的多个实例最终使用同一套画像。每个进程缓存读取结果 60 秒；管理员刷新时当前进程立即失效缓存并清空 ChatGPT Web Cookie 罐，其他实例在下一次观察到画像 ID 变化时也会清空自己的进程内 Cookie 罐。

管理后台路径为「系统 → 通用设置 → 基础设施 → 浏览器指纹」。`admin.browserProfile.get` 需要 `SYSTEM_READ`，`admin.browserProfile.regenerate` 需要 `SYSTEM_OPERATE`。刷新会生成新的 seed、画像和 installationId，原子递增 revision、写入脱敏审计记录，并使上游把后续请求视为新设备；共享账号可能因此需要重新验证。它不会改动账号自己的 `oauthDeviceId`。`OAI-Session-Id` 模拟网页生命周期：同一服务进程内由进程 nonce + `oauthDeviceId + profile.id` 稳定派生为 UUIDv4，进程重启（相当于页面重载）后轮换；画像变化也会得到新的会话身份。

## Installation identity for CLI-impersonating providers（CLI 模拟服务的共享安装身份）

`BrowserDeviceProfile.installationId` 是平台级安装 UUIDv4。它在画像首次生成时创建，随画像 JSON 一起持久化，所有服务实例读取同一行后得到同一个值。刷新浏览器指纹会生成新的 `installationId`；普通进程重启、缓存失效或多实例并发读取不会改变它。

旧的 D1 持久化行没有 `installationId` 字段。服务读取这类行时会用既有 `profile.id` 补齐并回写画像 JSON，因此已有安装不会因为升级产生新的上游设备身份。新的画像会同时保留内部 `profile.id` 和共享安装身份，便于把浏览器会话与 CLI 风格设备身份分开管理。

同构辅助函数通过 `@lobechat/model-runtime/browserProfile` 导出：

- `deriveGrokAgentId(installationId)`：按 `uuid5(NAMESPACE_OID, 'aihub-grok-agent:' + installationId)` 生成 Grok CLI 风格 agent id。
- `deriveStableMachineId(installationId, purpose)`：返回 `sha256(purpose + ':' + installationId)` 十六进制字符串，用于需要稳定机器键但不需要 UUID 形状的场景；`purpose` 必须非空，用于隔离不同调用场景。
- `deriveConversationSessionId(key, firstSeenMs)`：生成 UUIDv7 形状的会话 id，前 48 位为 `firstSeenMs` 时间戳，其余随机位由 `sha256(key)` 确定。

Grok 侧从 `installationId` 派生安装级 agent id，并按会话键 + 会话首次出现时间派生 UUIDv7 形状的会话 id。刷新浏览器指纹会轮换 `installationId`，因此后续 Grok agent id 也会随之变化。

### 没有安装身份就不发请求（fail closed）

`initModelRuntimeWithUserPayload` 对 ChatGPT Web 与 Grok 都要求调用方先取得安装画像，取不到直接抛错；Cursor 缺少时只是退化为由 CLI 自己生成 chat id。记忆 / 人物志的非托管选路（用户自带 Key 或系统配置）不再直接 `ModelRuntime.initializeWithProvider`：选中的服务商属于这三个时会改走同一个 seam 并带上安装画像，无法解析画像时以「请为该智能体换一个服务商」的明确错误拒绝；其他服务商的构造保持逐字不变。数据库暂时不可用而回退到内置兜底画像时，兜底画像的 `installationId` **不会**下发：包里内置的常量在所有部署中完全相同，用它冒充设备比拒绝这次请求更糟。此时 Grok 运行时以 `ProviderBizError: Grok installation identity missing` 拒绝该请求，模型列表等不带 CLI 头的调用不受影响。

### 一次会话 = 一个上游会话 id

会话 id 的前 48 位是「这次会话真正开始的时间」，不能是任何固定值（否则同一安装的所有会话共享同一个时间戳，任何真实客户端都不会这样）。`apps/server/src/modules/ModelRuntime/conversationIdentity.ts` 因此**推导**而不是**记忆**这个身份：

- 有 topic 时：会话键 = `user:<用户>:topic:<topic>`，开始时间 = 该 topic 行的 `createdAt`。两者都在数据库里，因此任何副本、任何重启后推导出的会话 id 完全一致。topic 行每进程只读一次（同一 topic 的并发首轮共用一次查询，`createdAt` 不会变，所以缓存不会过期）。
- 新会话第一轮还没有 topic（LobeHub 在首条回复期间才建 topic）。这一轮用 `user:<用户>:agent:<助理>:pending` 加进程内首次出现时间，是唯一没有持久身份的情况：**它与后续带 topic 的轮次不是同一个上游会话**，每个新会话因此有一次性的会话切换 —— 与真实 CLI 在会话建立前先发一次预热调用的效果相同。
- 既没有 topic 也没有助理 id 的调用（后台任务、工具、内容审计、记忆、连通性检查）每次构造运行时都会拿到独立的 `user:<用户>:op:<uuid>`，互不相干的操作永远不会合并成同一个上游会话；智能体运行（operation）例外，它按 operation id 成键，整个多步执行是一个会话。
- 轮次序号 = 载荷里的用户消息数。它由请求本身推导，各副本一致；已知偏差：历史被截断或摘要替换时序号会变小，而真实 CLI 只增不减 —— 修掉需要按 topic 持久化计数器，本轮不引入表结构变更。
- 智能体运行（operation）的开始时间取自它自己的持久化状态（`AgentState.createdAt`）：人工打断后恢复、进程重启、换副本执行，推导出的会话 id 都不变；只有状态里没有可用时间戳时才退回进程内首次出现时间。

已知残留（本轮接受，不改行为）：

1. topic 行暂时读不到（尚未可见或数据库瞬时故障）时，这一轮先用「现在」作为开始时间；60 秒后未命中过期、topic 变得可读，同一个会话键会改用 `topic.createdAt`，上游会话因此切换一次。宁可切一次身份，也不让一次可恢复的读失败直接毁掉这次模型调用。
2. 同一用户、同一助理在 10 分钟空闲 TTL 内开的两个新会话，首轮共用 `user:<用户>:agent:<助理>:pending` 键，会被上游看作同一个会话的两轮。
3. 该 pending 首次出现时间只存在于当前进程：多副本或重启后同一场景可能得到不同的开始时间。

三点同源 —— 会话在建 topic 之前没有任何持久身份。后续正解是让客户端在第一轮就生成会话 id 与开始时间并随请求上送（或服务端在建 topic 前先落库），届时可一次性去掉 pending 键、未命中提升与进程内时间。

### 时区依赖完整 ICU

画像按 IANA 时区名在请求时重新计算当前偏移与时区长名（夏令时正确），数据来自运行时的 tzdata/CLDR。因此部署必须使用带完整 ICU 的 Node（项目镜像即是）：small-ICU 只认得 UTC，会静默退回画像里存的标准时偏移，与 IANA 名字自相矛盾。`packages/model-runtime/src/browserProfile/timezone.test.ts` 会在当前运行时逐个解析池中的全部时区，small-ICU 环境下测试直接失败。

## 供其他服务商复用

服务端先取得安装画像，再把它和对应的 impersonate 目标一起注入传输和模型运行时：

```ts
import { PlatformBrowserProfileService } from '@/server/enterprise/services/browserProfile';
import {
  buildClientHintHeaders,
  buildFetchMetadataHeaders,
  userAgentHeaders,
} from '@lobechat/model-runtime/browserProfile';

const profile = await new PlatformBrowserProfileService(db).getOrFallback();

const headers = {
  ...userAgentHeaders(profile),
  // 只有目标站点用 Accept-CH 声明过高熵 client hint 时才用 'high'：
  // 浏览器不会主动发送站点没有申请的 hint，多发就是可被检测的特征。
  // chatgpt.com 什么都不申请（2026-08-18 实测），因此走 'low'。
  ...buildClientHintHeaders(profile, { entropy: 'low' }),
  ...buildFetchMetadataHeaders('xhr'),
};
```

新的浏览器模拟服务商应直接消费 `BrowserDeviceProfile` 和这些通用 header builder，不要复制 UA、语言、屏幕或硬件常量，也不要从运行进程的宿主环境补值。服务端传输缓存键必须包含 `profile.impersonateProfile`，以免不同 TLS 画像复用同一个 curl 客户端配置。运行时只拿得到 `RuntimeBrowserDeviceProfile`（不含私有 seed）：seed 能还原整套身份，注入边界会把它剥掉。

ChatGPT Web 运行时的构造是 fail-closed 的：没有传入平台画像会直接抛错，避免某条链路悄悄用降级身份在同一个账号上开出第二台设备。
