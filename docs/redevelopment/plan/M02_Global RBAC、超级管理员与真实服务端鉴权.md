# M02・Global RBAC、超级管理员与真实服务端鉴权

> 2026-07-23: EasyAuth 授权模块已移除

> 波次：W1\
> 估算：2–3 人周\
> 前置依赖：M00、M01\
> 源码基线：LobeHub 2.2.10（设计基线提交 4bab1636408e60a7ee17b640490fbf33a310a325）

> 决策（2026-07-16）：平台角色的**授予入口为 EasyAuth**（iam.jiefakj.com，钉钉审批流），同步写入内建 RBAC 表；运行时仍以内建 RBAC 为唯一授权执行点。普通用户使用 AIHub 需先经 EasyAuth 授予基础访问权限（`aihub.access`）。

## 1. 交付目标

- 建立严格的平台全局权限模型和服务端鉴权中间件。
- 支持超级管理员与固定子管理员角色包。
- 将 AIHub 注册为 EasyAuth 应用，平台角色经钉钉审批授予后同步至内建 RBAC；实现基于 EasyAuth 的用户基础准入。
- 修复工作区角色可能被错误用于平台权限的问题，并保护最后一名超级管理员。

## 2. 范围

- 扩展权限常量、平台角色、全局作用域查询、管理员 Procedure、初始化 CLI。
- EasyAuth 集成：应用描述符（`/.well-known/easyauth-app.json`，app\_key=`aihub`）、权限目录发布、AccessGrant 同步、`aihub.access` 用户准入与 “申请权限” 引导页。
- 把管理 API 的授权检查集中到 `withPlatformPermission`。
- 企业部署下启用真实 `withScopedPermission`；保留 Flag 关闭兼容路径。

## 3. 明确非范围

- 首版不提供任意自定义角色编辑器。
- 不把 Better Auth `users.role` 作为最终授权源。
- 不允许客户端传入 workspaceId 或 role 名称影响平台鉴权。

## 4. 当前源码落点

- `packages/const/src/rbac.ts`：权限动作和 `super_admin`。
- `packages/database/src/schemas/rbac.ts`：角色、权限、用户角色表，`workspace_id` 可空。
- `packages/database/src/models/rbac.ts`：当前 scope 查询和 `updateUserRoles()`。
- `packages/business-server/src/trpc-middlewares/rbacPermission.ts`：OSS no-op 中间件。
- `src/libs/better-auth/define-config.ts`：Better Auth `admin()` 插件。

参考实现（本机路径，实现 EasyAuth 集成前先分析）：

- EasyAuth 服务与 SDK：`/Users/konata/code/EasyAuth`（线上 iam.jiefakj.com）。权限查询 API 见 `src/easyauth/api/views.py`；Python SDK 见 `sdk/python/src/easyauth_app_sdk/`；对接指南见 `docs/guides/easyauth-app-sdk-integration.md`；应用 / 凭据模型见 `src/easyauth/applications/models.py`。
- EasyTrade 集成参照：`/Users/konata/code/EasyTrade`（线上 etrade.jiefakj.com）。EasyAuth 客户端封装见 `backend/app/domain/authz/easyauth_client.py`；按路由权限校验见 `backend/app/api/v1/authz_dependencies.py`（`require_permission` + 拒绝页 + permissionRequestUrl 引导模式）。

## 5. 建议新增目录 / 文件

- `apps/server/src/enterprise/guards/platformPermission.ts`。
- `packages/database/src/models/platform/platformRbac.ts` 或给现有 `RbacModel` 增加严格方法。
- `scripts/enterprise/bootstrap-super-admin.ts`。
- `packages/const/src/platform/permissions.ts`。

## 6. 目标设计

- 平台权限统一使用 `platform_*:action:all`；在 `getAllowedScopesForAction` 中让 `platform_` 资源只允许 ALL。
- `hasGlobalPermission()` 必须显式匹配 `roles.workspace_id IS NULL`，不得复用 “未传 workspaceId” 语义。
- `replaceGlobalUserRoles()` 只删除全局角色分配，绝不触碰工作区角色。
- 超级管理员可通过系统角色获得所有平台权限；其他角色按权限白名单。
- 最后一名活跃超级管理员的移除、封禁、过期和删除必须在同一事务中拒绝。
- **EasyAuth 同步**：AIHub 以静态 App Token（或 OAuth2 client credentials）调用 EasyAuth `GET /api/v1/apps/aihub/users/{authentik_user_id}/permissions`；将返回的 grants 按映射表写入 `rbac_user_roles`（全局作用域），记录 `grant_version` 与同步时间；同步在用户登录时触发并辅以定时任务，操作幂等。
- **准入**：`aihub.access` 由 EasyAuth 授予；未授予者登录成功后仅能访问 “申请权限” 引导页（跳转 EasyAuth 门户），所有业务 API 返回 `ACCESS_NOT_GRANTED`。
- **降级行为**：EasyAuth 不可用时沿用最近一次同步结果继续运行并记录告警；本地超级管理员（G-04/G-05 Break-glass）不经 EasyAuth 授予，不受同步影响。
- EasyAuth 授予的角色不得触碰工作区角色；`super_admin` 仍只能由本地初始化或既有超级管理员授予，不进入 EasyAuth 权限目录。

## 7. 数据模型与持久化

- 复用现有 RBAC 表；新增权限和系统角色种子。
- 必要时为 `rbac_roles(workspace_id,name)`、`rbac_user_roles(user_id,role_id,expires_at)` 增补索引 / 唯一约束。
- 不新增第二套管理员角色表。

## 8. 服务端 API / Contract

- `admin.auth.getMyAccess`：返回管理员菜单所需权限集合。
- `admin.roles.listSystemRoles`、`admin.roles.listUserAssignments`。
- `admin.roles.replaceUserGlobalRoles`：带 expectedRevision/reason。
- `admin.easyauth.getSyncStatus` / `triggerSync`：查看 / 触发 EasyAuth grants 同步（幂等，写审计）。
- `platform.getAccessStatus`：返回当前用户准入状态与 EasyAuth 申请入口 URL（未准入引导页使用）。
- HTTP `GET /.well-known/easyauth-app.json`：EasyAuth 应用描述符（权限目录 manifest）。
- `withPlatformPermission(code)`、`withAnyPlatformPermission(codes)`。

## 9. 管理端与用户端 UI

- 菜单和按钮按权限裁剪，但路由进入后仍请求服务端鉴权。
- 403 页面区分 “已登录但无平台权限” 和 “会话失效”。
- 角色编辑 UI 显示角色用途和到期时间，不显示底层数据库 ID 为主要信息。

## 10. 运行时接入

- 每个管理 tRPC Procedure 创建 `PlatformAuthContext`：actorId、permissions、requestId、reauthAge。
- 普通业务请求中的管理员身份不会自动绕过 Managed Guard；资源管理必须走 admin Router。

## 11. 分 PR 实施步骤

1. PR-009：权限常量、角色种子和严格 Global Query。
2. PR-010：`withPlatformPermission`、测试 Caller 和错误码。
3. PR-011：一次性超级管理员 CLI、幂等启动检查。
4. PR-012：最后超级管理员保护与角色分配 API。
5. PR-013：在企业 Flag 下替换 no-op scoped middleware，并完成现有路由回归。
6. PR-013A：EasyAuth 应用描述符、grants 同步服务、`aihub.access` 准入 Guard 与 “申请权限” 引导页。

## 12. 测试清单

- 工作区 Owner/Member/Viewer 访问所有 admin API 均为 403。
- 全局角色过期后立即失效；Redis 缓存不得延迟超过约定 TTL。
- 最后一名超级管理员无法被移除、封禁或设置已过期。
- 伪造前端权限、直接调用 tRPC、改变 workspace Header 均不能提升权限。
- 未获 `aihub.access` 的用户登录后仅见申请引导页，业务 API 一律 `ACCESS_NOT_GRANTED`。
- EasyAuth grants 同步幂等：重复同步不产生重复角色；EasyAuth 撤销后下次同步移除对应全局角色。
- EasyAuth 不可用时按最近同步结果运行并产生告警；本地超级管理员登录与权限不受影响。

## 13. 上线与回滚

- 先在测试环境种子至少两名超级管理员，再启用真实 RBAC。
- 保留受控 CLI 修复角色，但 CLI 需要数据库 / 运维权限，不暴露为网页接口。

## 14. Definition of Done

- 所有 admin Router Procedure 均有显式权限声明。
- 权限矩阵自动化测试覆盖 allow/deny。
- `updateUserRoles()` 不被管理员后台复用。

## 15. 主要风险与控制

- 启用真实 scoped 权限可能暴露现有工作区授权缺陷；需以 Flag 分阶段开启并运行回归。
- 双角色源漂移；Better Auth role 只作为兼容镜像或展示，不参与授权决策。
- EasyAuth grants 与内建 RBAC 漂移：以 EasyAuth 为授予事实源、内建 RBAC 为执行副本，同步必须幂等并记录 grant\_version；手工在 /admin 修改经 EasyAuth 授予的角色应被禁止或在下次同步被纠正（本地初始化的 super\_admin 除外）。

## 16. 模块移交物

- 权限字典、角色包、全局查询、tRPC 中间件、初始化 CLI、权限矩阵测试。
