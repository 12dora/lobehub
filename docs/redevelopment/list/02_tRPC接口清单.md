# tRPC Router 与接口清单

| Router | Procedure | 模块 | 性质 | 权限 | 关键约束 |
| --- | --- | --- | --- | --- | --- |
| admin.auth | getMyAccess | M02 | 读 | 登录用户 | 返回平台权限和菜单能力 |
| admin.easyauth | getSyncStatus/triggerSync | M02 | 读写 | platform_role:* | EasyAuth grants 同步至内建 RBAC，幂等、写审计 |
| platform | getAccessStatus | M02 | 读 | 登录用户 | 返回 `aihub.access` 准入状态与 EasyAuth 申请入口 URL |
| admin.users | list/get/ban/unban/revokeSessions/replaceGlobalRoles | M04 | 读写 | platform_user:* | 危险操作需 reason/reauth |
| admin.settings | getDraft/saveDraft/validate/publish/rollback | M05 | 读写 | platform_settings:* | expectedRevision |
| user.settings | getEffective/patchOverride/resetOverride | M05 | 读写 | 本人 | locked 服务端拒绝 |
| admin.managedResources | get/saveDraft/publish | M06 | 读写 | platform_policy:* | observe/ui/enforced |
| admin.aiProviders | CRUD/test/publish/rollback | M07 | 读写 | platform_ai_provider:* | Secret replace semantics |
| admin.aiModels | CRUD/reorder/dependents | M07 | 读写 | platform_ai_model:* | 依赖校验 |
| admin.skills | CRUD/validate/publish/rollback/dependents | M08 | 读写 | platform_skill:* | 版本不可变 |
| admin.connectors | CRUD/discover/test/publish/rollback | M09 | 读写 | platform_connector:* | SSRF 安全 Client |
| user.connectors | listManaged/startAuthorization/status/disconnect | M09 | 读写 | 本人 | 只能操作 Binding |
| admin.agents | CRUD/validate/publish/assign/rollout/rollback | M10 | 读写 | platform_agent:* | 默认 Agent 替代保护 |
| platform.agents | getEffectiveList/getEffectiveAgent | M10 | 读 | 本人 | 不泄露管理元数据 |
| admin.identityProviders | CRUD/discover/test/publish/rollback | M11 | 读写 | platform_identity:* | pending_restart |
| admin.branding | getDraft/saveDraft/publish/rollback/uploadAsset | M12 | 读写 | platform_branding:* | 公开快照分离 |
| platform | getCapabilities/getPublicSnapshot | M00/M12 | 读 | 公开/本人 | 不返回 Secret/管理权限细节 |
| admin.audit | list/get/export | M01/M13 | 读 | platform_audit:* | 游标/限量/脱敏 |
| admin.system | getStatus/getJobs/retry/cancel/getInstanceRevisions | M14 | 读写 | platform_system:* | 不返回连接串 |
| admin.system | getAuthSnapshotStatus/requestRestart | M11 | 读写 | platform_oidc:publish:all | 受控重启（G-06 重启激活按钮）；需 reauth + reason + 审计 |

## 接口统一规则

- 管理写接口必须包含 `reason`；发布/回滚包含 `expectedRevision`。
- 分页使用 cursor + limit，limit 有服务端上限。
- Secret 输入使用 `keep|replace|clear`，输出仅为 configured/fingerprint/updatedAt。
- admin Router 使用 `withPlatformPermission`；普通用户 Router 使用本人身份和 Managed Guard。
- 管理员也不能通过普通 Router 修改受管资源。
- 错误码采用稳定业务码，前端不解析自由文本。
- 所有管理请求进入 Audit，失败操作按风险级别记录结果和错误分类。
