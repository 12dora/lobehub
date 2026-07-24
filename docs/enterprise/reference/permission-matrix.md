# RBAC 权限矩阵

服务端 RBAC 是唯一授权依据：每个 admin procedure 由平台权限中间件把关。前端按 `adminNavMeta.ts` 的 `requiredPermissions` 隐藏菜单，仅为体验优化，不构成安全边界。

- 平台权限清单：`packages/const/src/platform/permissions.ts`（`PLATFORM_PERMISSIONS`，单一事实源）
- 角色 → 权限包：`packages/const/src/platform/roles.ts`（`PLATFORM_ROLE_PERMISSIONS`）
- 工作区角色：`packages/const/src/rbac.ts`（`WORKSPACE_ROLE_PERMISSIONS`）

## 权限代码清单

平台权限统一格式 `platform_<资源>:<动作>:all`，仅可由 `workspace_id IS NULL` 的全局角色满足。

| 域        | 资源前缀               | 动作                                                                                        |
| --------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| 准入      | `platform_admin`       | `access`                                                                                    |
| 用户      | `platform_user`        | `read` `create` `update` `ban` `delete` `session_revoke` `role_manage`                      |
| 角色      | `platform_role`        | `read` `update`                                                                             |
| 设置      | `platform_settings`    | `read` `update` `publish`                                                                   |
| 策略      | `platform_policy`      | `read` `update` `publish`                                                                   |
| AI 服务商 | `platform_ai_provider` | `read` `create` `update` `delete` `test` `publish`                                          |
| AI 模型   | `platform_ai_model`    | `read` `create` `update` `delete` `publish`                                                 |
| 技能      | `platform_skill`       | `read` `create` `update` `delete` `publish`                                                 |
| 连接器    | `platform_connector`   | `read` `create` `update` `delete` `test` `publish`                                          |
| 助理      | `platform_agent`       | `read` `create` `update` `delete` `publish` `assign`                                        |
| 凭据      | `platform_credential`  | `read` `create` `update` `delete`                                                           |
| 身份      | `platform_identity`    | `read` `create` `update` `delete` `test` `publish`                                          |
| OIDC      | `platform_oidc`        | `publish`                                                                                   |
| 品牌      | `platform_branding`    | `read` `update` `publish`                                                                   |
| 审计      | `platform_audit`       | `read` `export` `conversation_read` `policy_update` `retention_operate` `legal_hold_manage` |
| 统计      | `platform_stats`       | `read`                                                                                      |
| 系统      | `platform_system`      | `read` `operate`                                                                            |

## 角色 → 权限矩阵

内置全局系统角色见 `PLATFORM_SYSTEM_ROLES`。图例：`✓` 全量（读 + 写 / 发布 / 操作）、`R` 只读、`R/X` 只读 + 导出、`—` 无。除 `platform_user` 外，所有角色均持 `platform_admin:access`。

| 角色            | 用户 | 角色 | 设置 | 策略 | AI  | 技能 | 连接器 | 助理 | 凭据 | 身份 / OIDC | 品牌 | 审计 | 审计・内容 | 统计 | 系统 |
| --------------- | :--: | :--: | :--: | :--: | :-: | :--: | :----: | :--: | :--: | :---------: | :--: | :--: | :--------: | :--: | :--: |
| super\_admin    |  ✓   |  ✓   |  ✓   |  ✓   |  ✓  |  ✓   |   ✓    |  ✓   |  ✓   |      ✓      |  ✓   |  ✓   |     ✓      |  ✓   |  ✓   |
| user\_admin     |  ✓   |  ✓   |  —   |  —   |  —  |  —   |   —    |  —   |  —   |      —      |  —   |  R   |     —      |  —   |  —   |
| ai\_admin       |  R   |  —   |  R   |  ✓   |  ✓  |  ✓   |   ✓    |  ✓   |  ✓   |      —      |  —   |  R   |     —      |  —   |  —   |
| identity\_admin |  R   |  —   |  —   |  —   |  —  |  —   |   —    |  —   |  —   |      ✓      |  ✓   |  R   |     —      |  —   |  —   |
| auditor         |  R   |  R   |  R   |  R   |  R  |  R   |   R    |  R   |  R   |      R      |  R   | R/X  |     —      |  R   |  R   |
| platform\_user  |  —   |  —   |  —   |  —   |  —  |  —   |   —    |  —   |  —   |      —      |  —   |  —   |     —      |  —   |  —   |

- 审计・内容 = `conversation_read` / `policy_update` / `retention_operate` / `legal_hold_manage`，默认仅 `super_admin`；`auditor` 只有元数据读取与导出，看不到会话内容。
- `auditor` 的只读集合由 `roles.ts` 从所有 `:read:` / `:export:` 代码派生，新增只读权限自动纳入。
- `workspace_owner`（连同 `workspace_member` / `workspace_viewer`）是工作区角色，权限来自 `WORKSPACE_ROLE_PERMISSIONS`（`workspace_id` 指向所属工作区），**不继承任何平台权限**，无法进入 admin 面板。

## 关键不变式

- **全局作用域**：平台权限行必须 `workspace_id IS NULL`；`isPlatformPermissionCode` 拦截，`RbacModel.getGlobalUserPermissions` 只读全局角色。任何工作区角色都不能满足 `platform_*` 权限。
- **基础准入**：首次建号（Better Auth `user.create.after`）经 `ensureDefaultPlatformUserRole` 授予 `platform_user`；该角色权限包为空 `[]`，无任何 admin API，仅代表已登录准入。
- **单闸校验**：admin procedure 用 `withPlatformPermission(code)` 单个权限把关；需多权限时用 `withAllPlatformPermissions([...])` 单一中间件，禁止叠加多个 gate（reconcile 断言每条路由恰好一个平台权限闸）。中间件先校验登录与 `ENABLE_PLATFORM_ADMIN` 特性开关，拒绝时写 `admin.permission.denied` 审计。
- **写操作按最小动作分权**：mutation 校验各自的 `create/update/delete/test/publish`，不以粗粒度 `update` 代偿；`list/get` 仅要求对应 `:read:`。
- **超管引导**：`super_admin` 不自动授予任何注册用户。仅通过运维一次性 CLI `apps/server/src/enterprise/bootstrap/superAdmin.ts`（`BOOTSTRAP_SUPER_ADMIN_USER_ID` / `_EMAIL` 提升已有用户；`BOOTSTRAP_ALLOW_CREATE=1` 创建本地 break-glass 凭据账号，一次性口令仅打印一次）。幂等，需 DB 访问，非 Web 端点；`AUTH_DISABLE_EMAIL_PASSWORD` 开启时拒绝创建 break-glass 账号。
