# 平台数据库表清单

AIHub 二开的表统一位于**平台域**，以 `platform_` 前缀与上游用户域表隔离；schema 定义在 `packages/database/src/schemas/platform/`，是本清单的唯一权威来源。下表按功能模块罗列全部平台域表及一句话用途；字段与约束细节以对应 schema 文件为准，不在此重复。

## RBAC 授权

平台管理端授权复用上游 RBAC 表（`rbac_` 前缀，非 `platform_`），定义于 `rbac.ts`。

| 表                      | 用途            |
| ----------------------- | --------------- |
| `rbac_roles`            | 角色定义        |
| `rbac_permissions`      | 权限点定义      |
| `rbac_role_permissions` | 角色 — 权限关联 |
| `rbac_user_roles`       | 用户 — 角色关联 |

## 审计（`auditLogs.ts` / `auditAdmin.ts`）

| 表                              | 用途                                                  |
| ------------------------------- | ----------------------------------------------------- |
| `platform_audit_logs`           | 仅追加审计日志；应用只 INSERT/SELECT，diff 入库前脱敏 |
| `platform_audit_policies`       | 审计策略单例（保留天数、内容访问模式、脱敏档位）      |
| `platform_audit_exports`        | 审计导出任务与产物元数据                              |
| `platform_audit_retention_runs` | 保留清理任务运行记录                                  |
| `platform_audit_legal_holds`    | 证据保全（legal hold），阻止清理                      |

## 资源版本与发布（`revisions.ts` / `catalogAuthority.ts`）

| 表                            | 用途                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| `platform_resource_revisions` | 所有可发布资源的不可变快照，支撑回滚 /diff/ 审计；已发布行只追加不改写 |
| `platform_catalog_authority`  | 各目录域的发布代数与变更戳，供多实例目录一致性对齐                     |

## AI 目录（`ai.ts`）

| 表                             | 用途                                               |
| ------------------------------ | -------------------------------------------------- |
| `platform_ai_providers`        | 全局 AI 服务商定义；密钥不入表，仅暴露 fingerprint |
| `platform_ai_provider_secrets` | 不可变加密的服务商密钥版本                         |
| `platform_ai_models`           | 平台服务商下的模型                                 |

## Skill 目录（`skills.ts`）

| 表                        | 用途                  |
| ------------------------- | --------------------- |
| `platform_skills`         | Skill 稳定身份        |
| `platform_skill_versions` | 不可变 Skill 版本快照 |

## Connector 目录（`connectors.ts` / `connectorGovernance.ts`）

| 表                                 | 用途                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| `platform_connectors`              | 可变 Connector 草稿身份；发布态从版本快照读取        |
| `platform_connector_secrets`       | 信封加密的 Connector 密钥版本；仅存 `kms://` 句柄    |
| `platform_connector_tools`         | 草稿态 Connector 工具（发布态嵌入版本快照）          |
| `platform_user_connector_bindings` | 用户自持 OAuth 绑定；token 列仅存 Vault/KMS 引用     |
| `platform_connector_oauth_states`  | 一次性 OAuth state；原始 state/PKCE/token 不入库     |
| `platform_connector_governance`    | 组织级 Connector 治理文档（单逻辑行，草稿 / 发布对） |

## Agent 目录与分发（`agents.ts`）

| 表                                               | 用途                                         |
| ------------------------------------------------ | -------------------------------------------- |
| `platform_agents`                                | 平台 Agent 身份与 system\_key                |
| `platform_agent_versions`                        | 不可变 Agent 版本快照                        |
| `platform_agent_assignments`                     | Agent 对用户 / 角色 / 全局的下发分配         |
| `platform_user_agent_materializations`           | 按用户的延迟物化状态与本地 Agent 映射        |
| `platform_user_agent_materialization_tombstones` | 平台 Agent 硬删除后遗留本地 Agent 的溯源墓碑 |

## 身份提供方（Authentik OIDC，`identity.ts`）

| 表                                            | 用途                                      |
| --------------------------------------------- | ----------------------------------------- |
| `platform_identity_providers`                 | 外部 OIDC 登录提供方草稿                  |
| `platform_identity_provider_secrets`          | 信封加密的不可变 OIDC client\_secret 版本 |
| `platform_identity_provider_test_attempts`    | 一次性、仅管理员的 OIDC 连通性测试流      |
| `platform_identity_provider_instances`        | 加载过 OIDC 启动产物的服务进程清单        |
| `platform_identity_provider_restart_requests` | 重启意图与结果台账；仅存一次性 token 摘要 |

## 品牌（`branding.ts`）

| 表                             | 用途                                        |
| ------------------------------ | ------------------------------------------- |
| `platform_branding`            | 品牌草稿 / 发布配置（服务层保证单例发布行） |
| `platform_branding_assets`     | 平台自持的不可变品牌资产对象                |
| `platform_branding_operations` | 品牌变更的持久幂等通道                      |

## 设置策略（`settings.ts`）

| 表                                | 用途                                                 |
| --------------------------------- | ---------------------------------------------------- |
| `platform_settings_bundle`        | 设置聚合指针 + 草稿（单例 `global`）                 |
| `platform_setting_policies`       | 路径级已发布设置策略（默认 / 锁定 / 隐藏）           |
| `user_setting_overrides`          | 用户级显式设置覆盖；用户域表，随用户硬删除级联       |
| `user_setting_override_revisions` | 用户级覆盖的单调修订令牌；用户域表，随用户硬删除级联 |

## 认证与布局（`authSettings.ts` / `sidebarLayout.ts` / `managedPolicy.ts`）

| 表                                   | 用途                                                        |
| ------------------------------------ | ----------------------------------------------------------- |
| `platform_auth_settings`             | 注册 / 邮箱域白名单等认证设置单例（`global`，CAS revision） |
| `platform_sidebar_layout`            | 首页侧边栏布局策略单例（user/platform 模式）                |
| `platform_managed_resource_policies` | 受管资源的执行策略（每资源一行）                            |

## 实例运维（`instances.ts` / `jobs.ts` / `adminMutationRate.ts`）

| 表                                     | 用途                                                                  |
| -------------------------------------- | --------------------------------------------------------------------- |
| `platform_instance_heartbeats`         | 单个服务进程的匿名清单行（仅进程内随机熵，无主机 / 网络属性）         |
| `platform_instance_revision_states`    | 各进程按域上报的修订 / 加载状态                                       |
| `platform_jobs`                        | 平台后台任务（分发 / 迁移 / 连接器同步 / 批量），租约 + 心跳 + 幂等键 |
| `platform_admin_mutation_rate_windows` | 多实例管理端变更限流窗口（主键为 actor+procedure 的 SHA-256 摘要）    |

## Secret / 全局凭据（`credentials.ts`）

| 表                                   | 用途                                                  |
| ------------------------------------ | ----------------------------------------------------- |
| `platform_global_credentials`        | 平台自持、全员共享的全局凭据元数据                    |
| `platform_global_credential_secrets` | 信封加密的全局凭据密钥版本；明文永不入表              |
| `platform_global_credential_uploads` | 文件凭据上传的短时暂存（仅密文，消费一次或 TTL 过期） |

## 用户表增量列（M04，`user.ts`）

上游 `users` 表新增鉴权失效纪元列：

| 列                                     | 用途                                                         |
| -------------------------------------- | ------------------------------------------------------------ |
| `auth_invalidated_at`                  | 安全纪元时间戳；此刻及之前签发的会话 / OIDC/API-key 一律拒绝 |
| `auth_invalidated_excluded_session_id` | 免于上述截断的单个受信 Better Auth 会话 id（非 token）       |

## 数据库设计规约

- **前缀隔离**：平台域表一律 `platform_` 前缀，与上游用户域分离；仅少数用户级派生表（如 `user_setting_overrides`）沿用用户域命名并随用户硬删除级联。
- **不可变历史表**：secret /revision/version 类表（`*_secrets`、`platform_resource_revisions`、`platform_*_versions` 等）只追加不改写；已发布快照永不原地更新。
- **密钥零明文**：密钥列仅存 `kms://` / `vault://` 引用与 fingerprint，明文 / 密文不进入普通表、版本、绑定、OAuth state 或审计日志。
- **显式 onDelete**：外键显式声明删除语义（CASCADE / RESTRICT），依赖 DB 触发器兜住跨表不变式（如物化行不得孤立于 assignment/user）。
- **游标索引优先**：列表查询走 `(created_at, id)` 等复合游标索引，优先于 OFFSET 分页。
- **压缩基线与有序后续迁移**：`0000_squash_baseline` 表达新安装基线，后续变更按
  [`meta/_journal.json`](../../../packages/database/migrations/meta/_journal.json)
  的顺序应用。演进遵循 expand/contract—— 先加列 / 加表并双写，DROP 或改名延后一个稳定版本，避免与运行中的旧进程产生 schema 冲突；不要在文档中复制固定迁移数量。
