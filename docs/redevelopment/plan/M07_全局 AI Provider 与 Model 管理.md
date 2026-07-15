# M07 · 全局 AI Provider 与 Model 管理

> 波次：W4  
> 估算：3–4 人周  
> 前置依赖：M01、M02、M03、M06  
> 源码基线：LobeHub 2.2.10（设计基线提交 4bab1636408e60a7ee17b640490fbf33a310a325）

## 1. 交付目标

- 由管理员集中配置、测试、发布和回滚 AI Provider/Model。
- 普通用户不再维护服务商定义和密钥，但可以使用允许的模型。
- 保持内置 Model Bank、环境变量和上游 Runtime 的兼容。

## 2. 范围

- 平台 Provider/Model Catalog、Secret、连接测试、发布事务、Runtime Adapter。
- Admin Provider/Model 页面和普通用户模型选择适配。
- 旧用户配置保留但在托管模式下不参与运行时。

## 3. 明确非范围

- 不把全局 Provider 写入某个用户的 `ai_providers`。
- 不向客户端返回 API Key 明文。
- 不在首版实现按部门/用户差异化 Provider，先做全局发布。

## 4. 当前源码落点

- `packages/database/src/schemas/aiInfra.ts`、`models/aiProvider.ts`、`models/aiModel.ts`。
- `apps/server/src/routers/lambda/aiProvider.ts`、`aiModel.ts`。
- `src/routes/(main)/settings/provider/`、`service-model/`。
- `apps/server/src/modules/ModelRuntime/` 与 Model Bank/Runtime 包。

## 5. 建议新增目录/文件

- `packages/database/src/schemas/platform/ai.ts`。
- `apps/server/src/enterprise/services/aiCatalog/`。
- `apps/server/src/enterprise/services/platformSecretService.ts`。
- `src/enterprise/client/routes/admin/ai/`。

## 6. 目标设计

- Provider 定义与 Secret 分离：公开字段可进入 Revision，Secret 仅存加密引用/密文。
- Provider 和 Model 使用稳定 `providerKey`/`modelKey`；展示名可改，内部键发布后不可随意改。
- 运行时合并建议：内置 metadata → 环境应急覆盖 → 平台 Published Catalog；非托管时再叠加用户/工作区配置。
- 发布前验证至少一个启用模型、Endpoint 合法、Secret 可解密、模型引用唯一。
- 禁用正在被默认 Agent/系统设置使用的模型时必须提示依赖并阻止或要求替代。

## 7. 数据模型与持久化

- `platform_ai_providers`：key、displayName、type、endpoint、secretRef、config、status、revision。
- `platform_ai_models`：providerId、key、displayName、abilities、context、pricing、enabled、sort。
- 唯一 `(provider_key)`、`(provider_id,model_key)`；按 status/enabled/sort 建索引。

## 8. 服务端 API / Contract

- `admin.aiProviders.list/get/createDraft/updateDraft/test/publish/archive/rollback`。
- `admin.aiModels.create/update/deleteFromDraft/reorder`。
- `platform.aiCatalog.getPublished`：只返回公开可用字段。
- 连接测试结果只返回状态、延迟、错误分类和经过清洗的信息。

## 9. 管理端与用户端 UI

- 抽取普通 Provider 配置中的表单/模型列表为纯 Feature，通过 Adapter 提供 admin 或 user 数据源。
- Admin 页面增加 Draft/Published、Test、Secret 状态、依赖和 Revision。
- 普通用户侧只显示可用模型和组织管理提示，不显示 Endpoint/Key 编辑。

## 10. 运行时接入

- AI Runtime 每次请求读取缓存的 Published Catalog；Secret 只在服务端执行时解密。
- 缓存键包含 Catalog Revision；发布事件立即失效。
- 平台 Provider 不应污染用户 Key Vault。

## 11. 分 PR 实施步骤

1. PR-031：Provider/Model Schema、Repository 和只读 Catalog。
2. PR-032：Secret 服务、测试连接、安全 Redaction。
3. PR-033：Draft/Publish/Rollback API。
4. PR-034：Runtime Adapter 与影子比对。
5. PR-035：Admin UI 与普通用户 UI 收口。
6. PR-036：启用 Provider/Model Managed Guard。

## 12. 测试清单

- Secret 创建后 API 再读取只显示 `configured=true`，不回显原值。
- 发布失败不改变当前 Published Revision。
- 禁用依赖中的模型被阻止。
- 多实例发布后在 SLA 内使用新 Revision。
- 普通用户旧 Mutation 返回受管错误。

## 13. 上线与回滚

- 先导入一个非关键测试 Provider，影子比较模型列表和调用结果。
- 再迁移默认 Provider；保留环境变量应急覆盖和回滚 Revision。

## 14. Definition of Done

- 可完成 CRUD Draft、测试、发布、回滚。
- 运行时、模型选择器和系统 Agent 使用同一 Catalog。
- 无 Secret 泄露，旧用户数据未删除。

## 15. 主要风险与控制

- Provider SDK 差异大；连接测试使用 Provider Adapter，不强行统一所有字段。
- 平台 Catalog 与上游 Model Bank 冲突；明确稳定键、来源优先级和合并测试。

## 16. 模块移交物

- AI Catalog、Secret 服务、发布 API、Runtime Adapter、Admin/User UI、迁移手册。
