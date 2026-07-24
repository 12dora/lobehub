# 管理后台路由与页面清单

`/admin` 独立路由树的唯一事实源是 `src/enterprise/client/nav/adminNavMeta.ts`（`ADMIN_NAV_ITEMS`）：菜单可见性、路由权限声明、面包屑三者都从它派生，不得各自维护副本。页面组件由 `src/enterprise/client/nav/adminPageCatalog.tsx`（`ADMIN_PAGE_BY_ID`，`id → componentId`）解析。本文镜像这两个文件；细节以代码为准。

## 路由树

权限列为 `PLATFORM_PERMISSIONS.*` 键（见 `@/const/platform/permissions`）；空 = 仅需 shell 访问（`platform_admin:access:all`）。同一节点声明的权限须全部具备（AND）。备注中 `隐藏` = `hideFromNav: true`（仅注册路由、深链可达，不进菜单）；`详情` = 参数化明细页。

| 路径                                                 | componentId                   | 所需权限                  | 备注                                                                              |
| ---------------------------------------------------- | ----------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `/admin`                                             | `OverviewPage`                | —                         | index = 概览                                                                      |
| `/admin/stats`                                       | `GlobalStatsPage`             | `STATS_READ`              |                                                                                   |
| `/admin/users`                                       | `UsersListPage`               | `USER_READ`               |                                                                                   |
| `/admin/users/:id`                                   | `UserDetailPage`              | `USER_READ`               | 隐藏・详情                                                                        |
| `/admin/reauth-complete`                             | `AdminReauthCompletePage`     | —                         | 隐藏・Better Auth 重认证回跳落地页；注册为**顶层路由**，不在 `AdminRootGate` 之下 |
| `/admin/unified`                                     | `UnifiedManagementPage`       | —                         | 仅 shell 门禁；页内各 Tab 自守 `SETTINGS_READ` / `POLICY_READ` / `CONNECTOR_READ` |
| `/admin/settings`                                    | `SettingsPolicyPage`          | `SETTINGS_READ`           | 隐藏・深链兼容（可见入口为 `/admin/unified`）                                     |
| `/admin/managed-resources`                           | `ManagedResourcesPolicyPage`  | `POLICY_READ`             | 隐藏・深链兼容（可见入口为 `/admin/unified`）                                     |
| **`/admin/ai`**                                      | `AiIndexRedirect`             | —                         | **AI 组父路径**：重定向到首个有权访问的子项；无任一子项权限则空态                 |
| `/admin/ai/providers`                                | `AiProviderSettingsPage`      | `AI_PROVIDER_READ`        | AI 组                                                                             |
| `/admin/ai/providers/:id`                            | `AiProviderSettingsPage`      | `AI_PROVIDER_READ`        | AI 组・隐藏・详情                                                                 |
| `/admin/ai/service-model`                            | `AiServiceModelSettingsPage`  | `SETTINGS_READ`           | AI 组                                                                             |
| `/admin/ai/skills`                                   | `AiSkillSettingsPage`         | `SKILL_READ`              | AI 组                                                                             |
| `/admin/ai/skills/:id`                               | `AiSkillSettingsPage`         | `SKILL_READ`              | AI 组・隐藏・详情                                                                 |
| `/admin/ai/connectors`                               | `AiConnectorSettingsPage`     | `CONNECTOR_READ`          | AI 组                                                                             |
| `/admin/ai/connectors/:id`                           | `AiConnectorSettingsPage`     | `CONNECTOR_READ`          | AI 组・隐藏・详情                                                                 |
| `/admin/ai/memory`                                   | `AiMemorySettingsPage`        | `SETTINGS_READ`           | AI 组                                                                             |
| `/admin/ai/catalog/providers`                        | `AiCatalogProviderListPage`   | `AI_PROVIDER_READ`        | AI 组・隐藏・草稿 / 发布 / 版本高级目录                                           |
| `/admin/ai/catalog/providers/:id`                    | `AiCatalogProviderDetailPage` | `AI_PROVIDER_READ`        | AI 组・隐藏・详情                                                                 |
| `/admin/ai/catalog/models`                           | `AiCatalogModelListPage`      | `AI_MODEL_READ`           | AI 组・隐藏                                                                       |
| `/admin/skills`                                      | `SkillListPage`               | `SKILL_READ`              | 隐藏・高级目录                                                                    |
| `/admin/skills/:id`                                  | `SkillDetailPage`             | `SKILL_READ`              | 隐藏・详情                                                                        |
| `/admin/connectors`                                  | `ConnectorListPage`           | `CONNECTOR_READ`          | 隐藏・高级目录                                                                    |
| `/admin/connectors/:id`                              | `ConnectorDetailPage`         | `CONNECTOR_READ`          | 隐藏・详情                                                                        |
| `/admin/agents`                                      | `AgentListPage`               | `AGENT_READ`              |                                                                                   |
| `/admin/agents/:id`                                  | `AgentDetailPage`             | `AGENT_READ`              | 隐藏・详情                                                                        |
| `/admin/identity-providers`                          | `SecurityAuthPage`            | `IDENTITY_READ`           | 「安全与认证」：承载「登录方式」与「通用设置」Tab；路径为深链兼容保留             |
| `/admin/branding`                                    | `BrandingPage`                | `BRANDING_READ`           |                                                                                   |
| **`/admin/audit`**                                   | `AuditIndexRedirect`          | —                         | **审计组父路径**：重定向到首个有权访问的子项；无任一子项权限则空态                |
| `/admin/audit/logs`                                  | `OperationLogsPage`           | `AUDIT_READ`              | 审计组                                                                            |
| `/admin/audit/live`                                  | `AuditLivePage`               | `AUDIT_CONVERSATION_READ` | 审计组                                                                            |
| `/admin/audit/conversations`                         | `ConversationsSearchPage`     | `AUDIT_CONVERSATION_READ` | 审计组                                                                            |
| `/admin/audit/conversations/:userId`                 | `ConversationUserPage`        | `AUDIT_CONVERSATION_READ` | 审计组・隐藏・详情                                                                |
| `/admin/audit/conversations/:userId/topics/:topicId` | `ConversationTopicPage`       | `AUDIT_CONVERSATION_READ` | 审计组・隐藏・详情                                                                |
| `/admin/audit/exports`                               | `ExportsPage`                 | `AUDIT_EXPORT`            | 审计组                                                                            |
| `/admin/audit/holds`                                 | `LegalHoldsPage`              | `AUDIT_LEGAL_HOLD_MANAGE` | 审计组                                                                            |
| `/admin/audit/retention`                             | `RetentionPage`               | `AUDIT_RETENTION_OPERATE` | 审计组                                                                            |
| `/admin/system`                                      | `SystemPage`                  | `SYSTEM_READ`             |                                                                                   |

组父路径（`/admin/ai`、`/admin/audit`）不是 placeholder，而是索引重定向：进入后落到当前身份首个可访问的子项（`AuditIndexRedirect` 用 `ADMIN_NAV_ITEMS` + `hasAllPermissions` 选择，AI 组同构）。`/admin` 索引即概览页。

## 路由实现要求

- **独立路由树**：由 `createAdminRouteTree`（`src/enterprise/client/routes/admin/createAdminRouteTree.tsx`）构建，挂在主布局之外，不嵌套用户端 layout。路径全部由 `ADMIN_NAV_FLAT` 派生（`/admin/foo` → 相对 `foo`），页面 element 由 `resolveAdminPage(id)` 单一注册表解析，禁止并行的 switch / 默认 placeholder。
- **web /electron 双配置同步**：路由经 `EnterpriseDesktopRoutesWithoutMainLayout` 注入 `desktopRouter.config.tsx` 与 `desktopRouter.config.desktop.tsx`，两份必须一致，否则某条构建路径出现白屏。
- **特性开关 fail-closed**：boot `enterprise.platformAdmin` 未开时返回 `[]`，既不挂 shell 也不挂扩展模块路由，且零 `admin.*` 请求。
- **门禁顺序**（`AdminRootGate`）：配置未就绪 → Loading；特性关闭 → 不可用态；移动端 → 明确不支持态；会话未加载 → Loading；**匿名 → 触发登录并跳登录态**；已登录 → `AdminAccessProvider`（`getMyAccess`）判定 loading /forbidden/error /allowed。
- **逐页权限**（`AdminPermissionOutlet`）：命中目录项则按 `canAccessAdminPath` 判定，**无权限 → 页面 403**；命中扩展模块路由时对所有匹配 `handle.admin.requiredPermissions` 取并集（子级 `[]` 不能覆盖带权父级）；**目录外未知路径 → 作用域 404**（`*` 通配落到 `NotFoundPage`）。
- **移动端不支持**：`isMobile` 直接渲染不支持态，不进入管理页。
- **页面须具备的状态**：loading /empty/error /forbidden/revision-conflict（版本冲突 / CAS 重载）/read-only（无写权限只读）/pending-restart（改动待重启生效）。壳层通用态见 `AdminStateSurfaces.tsx`。
- **菜单可见性 ≠ 安全边界**：`filterAdminNavByPermissions` 与前端路由守卫仅用于 UI 收敛与体验，真正的授权边界是服务端 procedure（`withPlatformPermission` 等）。任何前端可见性判断都不得作为访问控制依据。
