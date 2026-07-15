# M09 · 平台 Connector、凭据模式与每用户 OAuth

> 波次：W5  
> 估算：4–6 人周  
> 前置依赖：M01、M02、M03、M06、M13 安全设计  
> 源码基线：LobeHub 2.2.10（设计基线提交 4bab1636408e60a7ee17b640490fbf33a310a325）

## 1. 交付目标

- 把 Connector 定义与用户授权/Token 分离。
- 支持无凭据、共享服务账号和每用户 OAuth 三类模式。
- 在保持用户可授权的同时，关闭用户对 Endpoint、Tool 定义和 Client 配置的修改。

## 2. 范围

- Connector/Tool Catalog、凭据模式、OAuth Binding、Tool Policy、SSRF 防护、管理/用户 UI。
- 共享凭据与用户 Token 分开加密和审计。
- 支持连接测试、发布、回滚和断开授权。

## 3. 明确非范围

- Web 进程默认不允许任意 stdio 命令。
- 不允许管理员通过 UI 访问云元数据地址（169.254.169.254 等一律阻断）；私网/本机地址按 G-07 决策默认放行。
- 不把平台共享 Client Secret 返回给用户。

## 4. 当前源码落点

- `packages/database/src/schemas/connector.ts`、`models/connector.ts`、`connectorTool.ts`。
- `apps/server/src/routers/lambda/connector.ts`。
- `apps/server/src/services/connector/`，包括 OAuth Token 处理。
- `packages/ssrf-safe-fetch` 与 `packages/env/src/app.ts` 的 SSRF 配置。
- `src/routes/(main)/settings/connector/`。

## 5. 建议新增目录/文件

- `packages/database/src/schemas/platform/connector.ts`。
- `apps/server/src/enterprise/services/connectorCatalog/`。
- `apps/server/src/enterprise/services/safeOutboundHttpClient.ts`。
- `src/enterprise/client/routes/admin/connectors/`。
- `src/features/PlatformConnectorAuthorization/`。

## 6. 目标设计

- 平台定义保存 Endpoint、协议、Tool 列表、OAuth 元数据、策略；用户 Binding 保存授权状态和加密 Token。
- `none`：无需凭据；`shared_service_account`：仅服务端共享 Secret；`per_user_oauth`：用户完成授权。
- Tool 权限合并：平台 deny 永远优先；平台 allow 与 Agent allow 取交集；用户只能在允许范围内关闭。
- 所有 Discovery/Test/Runtime 请求使用统一 SafeOutboundHttpClient，校验协议、DNS 重绑定、重定向、响应大小和超时。CIDR 默认策略按 G-07 决策（2026-07-16）：私网/本机地址默认放行（单机部署需对接本机 MCP 服务），云 Metadata 地址强制阻断；策略做成配置项，便于未来收紧为 Allowlist 模式。
- stdio 仅可在隔离 Worker + 命令 Allowlist 下启用，首版建议完全禁用。

## 7. 数据模型与持久化

- `platform_connectors`：key、endpoint、transport、credentialMode、oauthConfig、secretRef、status。
- `platform_connector_tools`：connectorId、toolKey、schema、riskLevel、enabled。
- `platform_user_connector_bindings`：userId、connectorId、encryptedTokenRef、status、expiresAt、scopes。
- 唯一 `(connector_id,tool_key)`、`(user_id,connector_id)`。

## 8. 服务端 API / Contract

- `admin.connectors.*`：Draft CRUD、discover、test、publish、rollback、revokeAllBindings。
- `admin.connectors.tools.*`：策略、风险等级、排序。
- `user.connectors.listManaged`、`startAuthorization`、`getAuthorizationStatus`、`disconnect`。
- OAuth Callback 只根据签名 state 查 Binding，不信任客户端 connectorId。

## 9. 管理端与用户端 UI

- Admin 向导：基本信息 → 网络校验 → 凭据模式 → Tool 发现/策略 → 测试 → 发布。
- 用户侧只展示可用 Connector、授权状态、授权/重新授权/断开；不展示 Endpoint/Client Secret。
- 高风险 Tool 显示管理员策略和执行确认要求。

## 10. 运行时接入

- 执行前解析 Platform Connector Revision + User Binding + Agent Tool Policy。
- Token 刷新在服务端完成，刷新失败只影响该用户 Binding。
- 共享账号调用需要独立调用者审计和限流。

## 11. 分 PR 实施步骤

1. PR-041：Connector/Tool/Binding Schema 和 Repository。
2. PR-042：SafeOutboundHttpClient、SSRF 测试和 Endpoint 校验。
3. PR-043：Catalog Draft/Discover/Test/Publish。
4. PR-044：per-user OAuth Binding 与 Callback。
5. PR-045：Tool Policy 合并和 Runtime Adapter。
6. PR-046：Admin/User UI、Guard、审计。

## 12. 测试清单

- 阻止云元数据地址、DNS 重绑定和恶意重定向；localhost/私网按 G-07 默认放行，但配置收紧为 Allowlist 模式后必须立即生效并阻断。
- 用户 A 的 Token 不能被用户 B 使用或查询。
- 共享 Secret 不回显、不进入日志。
- 平台 deny Tool 无法被 Agent 或用户重新启用。
- OAuth state 重放、篡改、过期均失败。

## 13. 上线与回滚

- 先启用 `none` 模式低风险 Connector，再启用 per-user OAuth。
- 共享服务账号最后启用，并要求单独安全审批。
- 发现异常可按 Connector 单独禁用，不关闭全部 Tool。

## 14. Definition of Done

- 定义、凭据和用户绑定完全分层。
- 所有外连统一经过安全 Client。
- 每用户 OAuth 可独立授权/撤销，平台配置不可由用户修改。

## 15. 主要风险与控制

- Connector 是最高风险模块之一；SSRF、Token 泄露、RCE、过度授权必须单独威胁建模。
- 上游 Connector Schema 变化频繁；通过 Adapter 隔离，不直接复制全部字段。

## 16. 模块移交物

- Connector Catalog、Binding、OAuth、Tool Policy、SSRF 组件、Admin/User UI、安全报告。
