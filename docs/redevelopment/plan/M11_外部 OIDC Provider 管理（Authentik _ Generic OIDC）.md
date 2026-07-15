# M11 · 外部 OIDC Provider 管理（Authentik / Generic OIDC）

> 波次：W7  
> 估算：3–4 人周  
> 前置依赖：M01、M02、M03、M04、M13  
> 源码基线：LobeHub 2.2.10（设计基线提交 4bab1636408e60a7ee17b640490fbf33a310a325）

> 决策（2026-07-16）：按本模块**完整实施**（不走环境变量直配的简化路线）。首选对接企业 Authentik 实例（auth.jiefakj.com，上游对接钉钉）；登录页提供“使用工作账号登录”入口；发布后由管理后台内置“重启激活”按钮触发受控重启（G-06）。

## 1. 交付目标

- 允许管理员在后台配置外部登录 OIDC Provider。
- 支持 Discovery、Claim 映射、测试登录、发布、重启激活和 Last Known Good。
- 登录页提供“使用工作账号登录”按钮，登录后透传钉钉用户身份（与 EasyTrade 的接入模式一致）。
- 避免错误配置锁死全部管理员。

## 2. 范围

- 外部登录 Provider 数据模型、Secret、向导、网络校验、测试、启动快照和后台重启激活。
- 首版支持 Authentik 与 Generic OIDC；首选目标为企业 Authentik 实例（auth.jiefakj.com）。
- 保留环境变量 Provider 作为 Break-glass/兼容来源。

## 3. 明确非范围

- 本模块不是 LobeHub 自身 `/oidc` Provider 功能。
- 首版不承诺运行中热插拔 Better Auth Plugin。
- 不允许从浏览器直接访问 Issuer Discovery 以绕过服务端网络控制。

## 4. 当前源码落点

- `src/libs/better-auth/define-config.ts`：启动时 `initBetterAuthSSOProviders()`。
- `src/libs/better-auth/sso/` 和 `providers/authentik.ts`。
- `packages/env/src/auth.ts`：`AUTH_AUTHENTIK_*`、`AUTH_GENERIC_OIDC_*`。
- `apps/server/src/globalConfig/getServerAuthConfig.ts`：登录页 Provider 列表。
- `src/app/(backend)/oidc/`：这是应用作为 OIDC Provider，需避免混淆。

参考实现（本机路径，实现前先分析）：

- Authentik（含钉钉适配）：`/Users/konata/code/Authentik`（线上 auth.jiefakj.com）。钉钉 OAuth Source 与通讯录同步见 `authentik/sources/oauth/dingtalk/`（`client.py`、`sync.py`，字段归一化含 `userid`/`union_id`/`name`/`email`）。
- EasyTrade 登录参照：`/Users/konata/code/EasyTrade`（线上 etrade.jiefakj.com）。授权码 + PKCE 全流程见 `backend/app/api/v1/oidc_auth.py`；claim 提取与 JIT 建用户见 `backend/app/domain/identity/oidc.py`（`sub`、`name`/`preferred_username`、`dingtalk_user_id`、`dingtalk_title`）；“使用工作账号登录”按钮见 `frontend/src/app/[locale]/login/page.tsx`；OIDC 环境变量约定见仓库根 `.env.example`。
- EasyAuth（授权中心，见 M02）：`/Users/konata/code/EasyAuth`（线上 iam.jiefakj.com）。

## 5. 建议新增目录/文件

- `packages/database/src/schemas/platform/identity.ts`。
- `apps/server/src/enterprise/services/identityProvider/`。
- `src/libs/better-auth/sso/databaseSnapshot.ts`。
- `src/enterprise/client/routes/admin/identity/providers/`。

## 6. 目标设计

- 数据库保存 Draft/Published、Issuer、Client ID、SecretRef、Scopes、Claim Mapping、用户策略和激活状态。
- Authentik Provider 的默认模板与 EasyTrade 对齐：scopes 为 `openid profile email dingtalk`；显示名取 `name`/`preferred_username`；`email`、`picture` 映射邮箱与头像；`dingtalk_user_id`、`dingtalk_title` 保存到用户档案扩展字段，供后续对接（通知、审批）使用。
- 登录页按钮文案默认“使用工作账号登录”（`button_label` 可配置），排在本地登录之上。
- 发布只生成 `pending_restart` Snapshot；实例启动成功加载后上报 active revision。
- 激活机制（G-06 决策）：管理后台在 `pending_restart` 状态显示“重启激活”按钮，点击后由服务端执行受控进程重启（单机部署下退出进程、由容器编排/进程管理器拉起）；操作要求 `platform_oidc:publish:all` 权限、二次确认、重新认证并写审计。
- 启动合并顺序明确：Break-glass env Provider 永远保留；DB Published Provider 按稳定 ID 合并。
- 加载失败优先回退 Last Known Good；若不可用，只启用 Break-glass 并将健康状态标记 Degraded。
- 测试登录使用一次性 state/nonce 和独立回调，不直接把未发布配置投入正式登录。

## 7. 数据模型与持久化

- `platform_identity_providers`：key、type、issuer、clientId、secretRef、scopes、claimMapping、status、activationRevision。
- Revision 中只保存 Secret fingerprint/configured 标志，不保存明文。

## 8. 服务端 API / Contract

- `admin.identityProviders.*`：Draft CRUD、discover、validateNetwork、testStart、testResult、publish、rollback。
- `admin.identityProviders.getCallbackUrls`。
- `admin.system.getAuthSnapshotStatus` / `requestRestart`：**必须实现**（G-06 决策）。`requestRestart` 执行受控进程重启，要求 reauth、reason，并写审计。

## 9. 管理端与用户端 UI

- 七步向导：基本信息 → Discovery/网络 → Client → Claim → 用户策略 → 测试 → 发布/激活。
- 明确显示 Callback URL、当前 Published Revision、各实例 Active Revision、Pending Restart。
- `pending_restart` 状态下页面标题区显示“重启激活”主操作按钮：**样式必须与原项目设计体系一致**（复用 `@lobehub/ui` 既有 Button 视觉，不引入自定义样式）；点击后 `confirmModal` 二次确认（显示影响说明）并要求重新认证，成功后轮询实例 Active Revision 直至一致。
- 登录页“使用工作账号登录”按钮同样复用既有登录页组件视觉语言。
- Secret 写入后只显示已配置和更新时间。

## 10. 运行时接入

- `define-config.ts` 在进程启动时加载只读 Published Snapshot；不得在每次请求查数据库。
- 健康检查对 DB Snapshot 不可用、LKG 回退、实例 Revision 不一致分别报告。

## 11. 分 PR 实施步骤

1. PR-053：Schema、Secret、Discovery/SSRF Validator。
2. PR-054：Draft/测试登录/Claim 预览。
3. PR-055：Published Snapshot Loader、LKG、Break-glass。
4. PR-056：Admin 向导、Pending Restart、实例状态、“重启激活”按钮与 `requestRestart` 受控重启。
5. PR-057：Authentik 集成 E2E（含钉钉 claim 透传断言）和后台重启激活流程。

## 12. 测试清单

- 错误 Issuer、无 TLS、异常 Discovery、Claim 缺失均被识别。
- Secret 不回显。
- 测试成功不自动影响正式登录。
- 发布后未重启状态清晰；点击“重启激活”后所有实例 Revision 一致。
- “重启激活”按钮：无 `platform_oidc:publish:all` 权限不可见/不可调；未重新认证被拒；操作写审计。
- Authentik 登录后 `name`/`preferred_username`、`dingtalk_user_id`、`dingtalk_title`、头像正确落库。
- DB 配置坏时 Break-glass 仍可登录。

## 13. 上线与回滚

- 先在预生产接 Authentik 测试租户。
- 生产先添加为第二登录方式，不关闭本地登录。
- 至少一个完整登录周期稳定后，再考虑限制其他方式。

## 14. Definition of Done

- Authentik/Generic OIDC 可配置、测试、发布和回滚。
- 激活状态可观测，LKG 与 Break-glass 演练通过。
- 不与应用自身 OIDC Provider 配置混淆。

## 15. 主要风险与控制

- OIDC 错配影响面极大；必须独立发布窗口和演练。
- Better Auth 上游配置 API 可能变化；Snapshot Loader 只输出其稳定 Provider Definition Adapter。

## 16. 模块移交物

- OIDC Schema、向导、Discovery/测试、启动 Snapshot、LKG、运维手册、Authentik E2E。
