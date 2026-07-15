# M01 · 平台数据库、Revision、Audit 与 Job 基础设施

> 波次：W1  
> 估算：2–3 人周  
> 前置依赖：M00  
> 源码基线：LobeHub 2.2.10（设计基线提交 4bab1636408e60a7ee17b640490fbf33a310a325）

## 1. 交付目标

- 为所有平台级资源建立统一、可审计、可回滚的数据基础。
- 用不可变 Revision 和乐观锁解决并发编辑、发布和回滚。
- 提供追加式审计日志和幂等后台任务框架。

## 2. 范围

- 新增平台 Schema、Repository 基类、事务发布器、审计记录器和 Job 状态机。
- Migration 0 只建表、索引和约束，不改变现有读取路径。
- 定义平台资源公共字段：状态、Revision、创建者、更新者、时间戳。

## 3. 明确非范围

- 不在此模块实现具体资源业务校验。
- 不把 Audit 当作应用日志替代品。
- 不使用数据库触发器隐藏业务流程；审计由显式服务事务写入。

## 4. 当前源码落点

- `packages/database/src/schemas/index.ts`：Schema 汇总导出。
- `packages/database/src/models/`：已有 Model/Repository 风格。
- `packages/database/migrations/`：Drizzle 生成 SQL 与迁移顺序。
- `packages/database/src/models/__tests__/drizzleMigration.test.ts`：迁移测试。
- `apps/server/src/runtimeConfig/`：Redis/Env Snapshot 模式可用于 Revision 缓存。

## 5. 建议新增目录/文件

- `packages/database/src/schemas/platform/`：按领域拆分 Schema。
- `packages/database/src/models/platform/`：Revision、Audit、Job 及各领域 Repository。
- `apps/server/src/enterprise/services/platformPublisher.ts`。
- `apps/server/src/enterprise/services/platformAudit.ts`。

## 6. 目标设计

- 所有发布型资源使用 `draft`、`published`、`archived`；已发布 Revision 不允许原地修改。
- 发布事务必须同时：校验 expectedRevision、写 Revision、更新当前指针、写 Audit；任一步失败全部回滚。
- Audit 记录 actor、action、target、requestId、IP 摘要、UA 摘要、reason、redacted diff 和结果。
- Job 使用幂等键、游标、重试次数、租约和心跳，避免多实例重复执行。

## 7. 数据模型与持久化

- `platform_resource_revisions`：资源类型/ID、revision、redactedPayload、checksum、createdBy。
- `platform_audit_logs`：append-only，按 createdAt、actorId、targetType/Id 建索引。
- `platform_jobs`：type、status、idempotencyKey、cursor、progress、attempt、leaseUntil、error。
- 后续模块表由各自文档定义；Migration 0 可一次建完空表，也可按模块拆分 Migration 以降低审查规模。

## 8. 服务端 API / Contract

- 内部 Repository：`publishDraft()`、`rollbackToRevision()`、`getPublishedSnapshot()`。
- 管理 API 公共输入包含 `expectedRevision`、`reason`；冲突返回 `PLATFORM_REVISION_CONFLICT`。
- 审计查询支持游标分页，不允许无界导出。

## 9. 管理端与用户端 UI

- Admin 通用组件显示 Draft/Published/Archived、当前 Revision、发布时间和编辑冲突。
- 危险发布要求确认理由；回滚页面显示差异但不展示 Secret 明文。

## 10. 运行时接入

- 发布完成后通过配置事件或 Redis Version Key 触发各实例失效。
- 数据库是事实源；Redis 丢失时允许从数据库重建，不允许反向以缓存覆盖数据库。

## 11. 分 PR 实施步骤

1. PR-005：Schema 与 Migration 0；所有表可为空、Flag 关闭无行为变化。
2. PR-006：Revision/Audit Repository、事务测试和 Redaction。
3. PR-007：Job Repository、租约/重试/幂等测试。
4. PR-008：公共发布服务和配置失效事件接口。

## 12. 测试清单

- Migration 从空库和 2.2.10 典型数据快照均可升级。
- 并发发布只有一个成功，另一个得到 Revision 冲突。
- 审计记录中不出现 API Key、Client Secret、Token、Authorization Header。
- Job Worker 崩溃后租约到期可继续，幂等键不重复执行副作用。

## 13. 上线与回滚

- 先运行 Migration 0，再部署读取代码；不开启写 Flag。
- 回滚应用版本时保留新增表；不要在同一窗口执行 DROP。

## 14. Definition of Done

- 迁移测试、事务测试、索引检查全部通过。
- 至少一个示例资源可完成 Draft→Publish→Rollback。
- 审计和 Job 有独立运维查询与清理策略。

## 15. 主要风险与控制

- 单表 Revision JSON 过大；大对象只保存规范化快照或对象存储引用并附 checksum。
- 审计无限增长；必须提供分区/归档计划和保留期。

## 16. 模块移交物

- Migration、Schema、Repository、发布事务、审计服务、Job 状态机、运行手册。
