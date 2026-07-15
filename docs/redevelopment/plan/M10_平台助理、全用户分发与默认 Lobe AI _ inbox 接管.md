# M10 · 平台助理、全用户分发与默认 Lobe AI / inbox 接管

> 波次：W6  
> 估算：4–6 人周  
> 前置依赖：M05、M07、M08、M09  
> 源码基线：LobeHub 2.2.10（设计基线提交 4bab1636408e60a7ee17b640490fbf33a310a325）

## 1. 交付目标

- 管理员可以为所有用户 CRUD、发布、回滚和分配平台助理。
- 安全接管默认 Lobe AI 的用户可见配置，同时保留内部 `inbox` 兼容。
- 避免为每次更新同步重写所有用户 Agent 行。

## 2. 范围

- 平台 Agent 模板、不可变版本、Assignment、延迟物化、Rollout Job、依赖校验。
- 支持 mandatory/default/optional 分配。
- 默认 Inbox 显示名、头像、Prompt、模型和 Tool 由平台版本管理。

## 3. 明确非范围

- 不把平台 Agent 直接存成某个系统用户的 Agent。
- 不改变内部 slug/key `inbox`。
- 不对所有用户同步执行大事务批量更新。

## 4. 当前源码落点

- `packages/database/src/schemas/agent.ts`、`models/agent.ts`。
- `apps/server/src/routers/lambda/agent.ts`、`services/agent/`。
- `src/store/agent`、`builtinAgentSelectors.inboxAgentId` 及大量 `inbox` 兼容逻辑。
- `src/const/settings` 的默认 Agent 配置。

## 5. 建议新增目录/文件

- `packages/database/src/schemas/platform/agent.ts`。
- `apps/server/src/enterprise/services/platformAgent/`。
- `apps/server/src/enterprise/jobs/agentRollout.ts`。
- `src/enterprise/client/routes/admin/agents/`。

## 6. 目标设计

- Agent 主表保存 identity/systemKey，版本表保存完整配置和依赖 Revision，Assignment 决定目标用户和可见性。
- 用户读取 Agent 列表时合并用户 Agent 与平台 Assignment；只有需要用户行的功能才延迟物化。
- 平台更新创建新版本；Assignment 可固定版本或跟随 latest published。
- 删除默认或被引用 Agent 前必须先指定替代项；一般采用 archive 而非物理删除。
- 默认 Inbox 使用 `systemKey=default-inbox` 映射到现有内部 `inbox`，仅改变用户可见属性和有效配置。

## 7. 数据模型与持久化

- `platform_agents`：key、systemKey、status、currentVersionId、assignmentMode。
- `platform_agent_versions`：config、provider/model、skillRefs、connectorRefs、checksum。
- `platform_agent_assignments`：agentId、targetType、targetId、mode、versionPolicy。
- 必要时 `platform_user_agent_materializations` 记录延迟物化和版本。

## 8. 服务端 API / Contract

- `admin.agents.*`：CRUD Draft、validateDependencies、publish、rollback、archive。
- `admin.agents.assignments.*`：全局/用户/角色目标、预览、启动 Rollout、进度。
- `platform.agents.getEffectiveList`、`getEffectiveAgent`。
- `admin.agents.setDefaultInbox`。

## 9. 管理端与用户端 UI

- 管理页面复用现有 Agent 配置控件，新增版本、分配范围、依赖、发布预览和 Rollout 进度。
- 用户侧平台 Agent 显示组织来源；Mandatory 不可隐藏，Optional 可隐藏但不可编辑受管字段。
- 默认 Inbox 可显示为 AIHub AI，但 URL、内部 key 和历史消息关联保持不变。

## 10. 运行时接入

- 聊天执行时使用 Effective Platform Agent Version；历史消息保留当时 provider/model 记录。
- Agent 发布前校验引用的 Provider/Model/Skill/Connector 均为 Published 且允许使用。
- 大规模物化通过 M01 Job 游标、幂等和可重试。

## 11. 分 PR 实施步骤

1. PR-047：Agent/Version/Assignment Schema 与 Repository。
2. PR-048：依赖校验和有效 Agent Resolver。
3. PR-049：列表合并与延迟物化。
4. PR-050：Admin CRUD/Version/Assignment UI。
5. PR-051：默认 `inbox` 接管和兼容测试。
6. PR-052：Rollout Job、进度、取消和回滚。

## 12. 测试清单

- 默认 Inbox 改名/改配置后，已有历史会话仍可访问。
- 内部 `inbox` 路由和 selector 不被替换。
- 发布时缺失依赖被拒绝。
- 大规模 Assignment 可中断、重试、不重复。
- 删除默认 Agent 必须先选择替代。

## 13. 上线与回滚

- 先发布一个 Optional 内部测试 Agent，再 Mandatory 小范围。
- 最后切换 default-inbox；保留前一 Revision 快速回滚。
- 全量分发采用分批/游标，监控数据库和队列。

## 14. Definition of Done

- 管理员可完整 CRUD Draft、发布、回滚、归档和分配。
- 用户列表/聊天使用同一 Effective Agent。
- 默认 Lobe AI 用户可见名称可替换且不破坏兼容。

## 15. 主要风险与控制

- Agent 依赖面广、上游变化快；保持 Adapter 和系统 key 稳定。
- 强制平台配置可能覆盖用户意图；明确哪些字段可 Overlay，默认受管字段不可改。

## 16. 模块移交物

- Agent 模板/版本/Assignment、Resolver、Rollout、Inbox 兼容、Admin/User UI。
