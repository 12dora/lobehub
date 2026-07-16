# tRPC Router 与接口清单

| Router                  | Procedure                                                          | 模块    | 性质 | 权限                                               | 关键约束                                                                      |
| ----------------------- | ------------------------------------------------------------------ | ------- | ---- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| admin.auth              | getMyAccess                                                        | M02/M04 | 读   | 登录用户                                           | 返回平台权限、菜单能力和服务端可信 `authMethod`；不信任客户端自报登录方式     |
| admin.easyauth          | getSyncStatus/triggerSync                                          | M02     | 读写 | platform\_role:\*                                  | EasyAuth grants 同步至内建 RBAC，幂等、写审计                                 |
| platform                | getAccessStatus                                                    | M02     | 读   | 登录用户                                           | 返回 `aihub.access` 准入状态与 EasyAuth 申请入口 URL                          |
| admin.users             | list/get/getAuditTrail/ban/unban/revokeSessions/replaceGlobalRoles | M04     | 读写 | platform\_user:\*；Audit 另需 platform\_audit:read | 严格 Zod 输出；危险操作需 reason/reauth；失败 / 拒绝也审计；服务端计算 isSelf |
| admin.settings          | getDraft/saveDraft/validate/publish/rollback                       | M05     | 读写 | platform\_settings:\*                              | expectedRevision                                                              |
| user.settings           | getEffective/patchOverride/resetOverride                           | M05     | 读写 | 本人                                               | locked 服务端拒绝                                                             |
| admin.managedResources  | get/saveDraft/publish                                              | M06     | 读写 | platform\_policy:\*                                | observe/ui/enforced                                                           |
| admin.aiProviders       | CRUD/test/publish/rollback                                         | M07     | 读写 | platform\_ai\_provider:\*                          | Secret replace semantics                                                      |
| admin.aiModels          | CRUD/reorder/dependents                                            | M07     | 读写 | platform\_ai\_model:\*                             | 依赖校验                                                                      |
| admin.skills            | CRUD/validate/publish/rollback/dependents                          | M08     | 读写 | platform\_skill:\*                                 | 版本不可变                                                                    |
| admin.connectors        | CRUD/discover/test/publish/rollback                                | M09     | 读写 | platform\_connector:\*                             | SSRF 安全 Client                                                              |
| user.connectors         | listManaged/startAuthorization/status/disconnect                   | M09     | 读写 | 本人                                               | 只能操作 Binding                                                              |
| admin.agents            | CRUD/validate/publish/assign/rollout/rollback                      | M10     | 读写 | platform\_agent:\*                                 | 默认 Agent 替代保护                                                           |
| platform.agents         | getEffectiveList/getEffectiveAgent                                 | M10     | 读   | 本人                                               | 不泄露管理元数据                                                              |
| admin.identityProviders | CRUD/discover/test/publish/rollback                                | M11     | 读写 | platform\_identity:\*                              | pending\_restart                                                              |
| admin.branding          | getDraft/saveDraft/publish/rollback/uploadAsset                    | M12     | 读写 | platform\_branding:\*                              | 公开快照分离                                                                  |
| platform                | getCapabilities/getPublicSnapshot                                  | M00/M12 | 读   | 公开 / 本人                                        | 不返回 Secret / 管理权限细节                                                  |
| admin.audit             | list/get/export                                                    | M01/M13 | 读   | platform\_audit:\*                                 | 游标 / 限量 / 脱敏                                                            |
| admin.system            | getStatus/getJobs/retry/cancel/getInstanceRevisions                | M14     | 读写 | platform\_system:\*                                | 不返回连接串                                                                  |
| admin.system            | getAuthSnapshotStatus/requestRestart                               | M11     | 读写 | platform\_oidc:publish:all                         | 受控重启（G-06 重启激活按钮）；需 reauth + reason + 审计                      |

## 接口统一规则

- 管理写接口必须包含 `reason`；发布 / 回滚包含 `expectedRevision`。
- 分页使用 cursor + limit，limit 有服务端上限。
- Secret 输入使用 `keep|replace|clear`，输出仅为 configured/fingerprint/updatedAt。
- admin Router 使用 `withPlatformPermission`；普通用户 Router 使用本人身份和 Managed Guard。
- 管理员也不能通过普通 Router 修改受管资源。
- 错误码采用稳定业务码，前端不解析自由文本。
- 所有管理请求进入 Audit，失败操作按风险级别记录结果和错误分类。
