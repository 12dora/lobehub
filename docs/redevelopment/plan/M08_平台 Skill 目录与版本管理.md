# M08 · 平台 Skill 目录与版本管理

> 波次：W5  
> 估算：2–3 人周  
> 前置依赖：M01、M02、M03、M06  
> 源码基线：LobeHub 2.2.10（设计基线提交 4bab1636408e60a7ee17b640490fbf33a310a325）

## 1. 交付目标

- 由管理员审核、发布和回滚全局 Skill。
- 普通用户使用已发布 Skill，但不维护平台定义。
- 通过不可变版本和依赖校验保证 Agent 引用稳定。

## 2. 范围

- Skill 元数据、版本内容、校验、发布、归档、运行时合并和管理 UI。
- 支持内置 Skill 与平台 Skill 的稳定合并。
- 提供依赖引用和使用情况查询。

## 3. 明确非范围

- 不允许任意上传可执行二进制。
- 不在首版实现外部 Marketplace 自动信任发布。
- 不批量复制 Skill 到每个用户表。

## 4. 当前源码落点

- `packages/database/src/schemas/agentSkill.ts`、`models/agentSkill.ts`。
- `apps/server/src/routers/lambda/agentSkills.ts`。
- `apps/server/src/services/skill/`、`skillManagement/`。
- `src/routes/(main)/settings/skill/`。

## 5. 建议新增目录/文件

- `packages/database/src/schemas/platform/skill.ts`。
- `apps/server/src/enterprise/services/skillCatalog/`。
- `src/enterprise/client/routes/admin/skills/`。

## 6. 目标设计

- Skill 主表保存稳定 identity，版本表保存不可变 manifest/prompt/content checksum。
- 发布前验证 Schema、大小、引用 Tool、权限声明、危险指令模式和本地化字段。
- 运行时合并 Builtin + Published Platform；相同 key 的平台覆盖需显式 allowOverride。
- 被已发布 Agent 引用的版本不能物理删除，只能归档并保留解析。

## 7. 数据模型与持久化

- `platform_skills`：key、displayName、status、currentVersionId。
- `platform_skill_versions`：skillId、version、manifest、contentRef、checksum、createdBy。
- 唯一 `(skill_id,version)` 和稳定 key。

## 8. 服务端 API / Contract

- `admin.skills.list/get/create/updateDraft/validate/publish/archive/rollback`。
- `admin.skills.getDependents`。
- `platform.skills.getPublishedCatalog`。

## 9. 管理端与用户端 UI

- 复用现有 Skill 列表与详情视觉，新增来源、版本、校验结果、依赖和发布状态。
- 用户端隐藏安装/编辑平台 Skill 的动作，保留查看、启用和按策略使用。

## 10. 运行时接入

- Agent 解析按 `skillKey + version` 或 Published 指针；发布新版本不应无审查地改变已固定 Agent Revision。
- 缓存按 Skill Catalog Revision 失效。

## 11. 分 PR 实施步骤

1. PR-037：Schema/Repository/版本模型。
2. PR-038：Validator 与安全扫描。
3. PR-039：发布 API、依赖查询、Runtime Catalog。
4. PR-040：Admin/User UI 和 Guard。

## 12. 测试清单

- 非法 manifest、超限内容、未知 Tool 引用无法发布。
- 旧 Agent 固定版本在新版本发布后保持可解析。
- 归档被引用 Skill 不破坏历史 Agent。

## 13. 上线与回滚

- 先发布只读内置目录视图，再创建平台 Skill。
- 启用托管前保证关键用户 Skill 的迁移/替代方案。

## 14. Definition of Done

- 版本不可变、可回滚、依赖可追踪。
- 普通用户不能修改平台定义。
- 运行时 Catalog 与 Admin Published 一致。

## 15. 主要风险与控制

- Skill 内容可能包含 Prompt Injection；发布校验不能替代运行时 Tool 权限。
- 覆盖内置 key 易造成升级冲突；默认禁止，必要时显式记录。

## 16. 模块移交物

- Skill Catalog、版本、Validator、依赖查询、Admin/User UI、Guard。
