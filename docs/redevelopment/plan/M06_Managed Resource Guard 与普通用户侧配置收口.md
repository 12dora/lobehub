# M06 · Managed Resource Guard 与普通用户侧配置收口

> 波次：W3  
> 估算：2–3 人周  
> 前置依赖：M02、M03、M05 能力接口  
> 源码基线：LobeHub 2.2.10（设计基线提交 4bab1636408e60a7ee17b640490fbf33a310a325）

## 1. 交付目标

- 统一控制 AI Provider、Model、Skill、Connector、Agent 是否由平台托管。
- 同时关闭导航、路由和服务端写接口，防止绕过 UI。
- 保留普通用户对已发布资源的使用能力和必要的个人授权。

## 2. 范围

- 平台受管资源策略、服务端 Guard、旧 Mutation 拦截、用户能力快照和 UI 收口。
- 支持 observe-only、UI-only、enforced 三阶段切换。
- 定义选择、授权、配置、发布四种不同权限语义。

## 3. 明确非范围

- 不删除已有用户 Provider/Connector 数据。
- 不允许管理员在普通用户 API 中自动绕过 Guard。
- 不把“隐藏菜单”当成完成标准。

## 4. 当前源码落点

- `apps/server/src/routers/lambda/aiProvider.ts`、`aiModel.ts`、`agentSkills.ts`、`connector.ts`。
- `src/routes/(main)/settings/provider`、`service-model`、`skill`、`connector`。
- `apps/server/src/routers/lambda/config/index.ts`：全局配置返回。

## 5. 建议新增目录/文件

- `apps/server/src/enterprise/guards/managedResource.ts`。
- `apps/server/src/enterprise/services/managedResourcePolicy.ts`。
- `src/enterprise/client/hooks/useManagedResourcePolicy.ts`。

## 6. 目标设计

- 策略项至少包含 resource、managed、enforcementMode、publishedRevision。
- Guard 根据调用的业务 Router 和操作类型判断；读取/使用、个人 OAuth 绑定、管理员定义写入分别处理。
- 普通业务请求中的超级管理员也不能修改平台资源；管理员必须使用 admin Router，确保 Revision/Audit/Secret 流程。
- 旧用户数据保留，可在非托管回滚时恢复；托管运行时忽略它但不批量清空。

## 7. 数据模型与持久化

- 可放入 `platform_setting_policies` 的专用 namespace，也可新增 `platform_managed_resource_policies`；建议独立表以便审计和索引。

## 8. 服务端 API / Contract

- `admin.managedResources.get/saveDraft/publish`。
- 普通 Router 写操作返回 `RESOURCE_MANAGED_BY_PLATFORM`。
- `platform.getCapabilities` 返回公开 managed 布尔值，不返回内部规则。

## 9. 管理端与用户端 UI

- 导航移除新增/配置入口；直接访问旧 URL 显示“由组织管理”说明并跳到可用资源列表。
- 用户仍可选择模型、启用允许的 Tool、执行每用户 OAuth、隐藏 optional Agent。
- 管理员页面提供策略变更影响预览。

## 10. 运行时接入

- 切换到 enforced 前，运行时 Adapter 必须已能读取平台发布资源，否则会导致可用资源为空。
- observe-only 记录本应被拒绝的调用，用于发现遗漏的客户端/自动化调用。

## 11. 分 PR 实施步骤

1. PR-027：策略类型、Repository、能力快照。
2. PR-028：Guard 与所有旧 Mutation 的覆盖测试。
3. PR-029：普通用户导航/路由收口和说明页。
4. PR-030：observe-only 指标、enforcement 切换和回滚测试。

## 12. 测试清单

- 直接构造 tRPC 请求无法新增/修改/删除受管资源。
- 用户仍可调用已发布 Provider/Model。
- per-user OAuth Connector 仍可授权和断开。
- 关闭托管后旧用户配置可恢复使用。

## 13. 上线与回滚

- 按资源逐个启用：Provider/Model → Skill → Connector → Agent。
- 每个资源先 observe-only 至少一个完整业务周期，再 enforced。

## 14. Definition of Done

- 所有相关旧 Mutation 有 Guard 测试。
- UI、路由、API 三层行为一致。
- 不存在管理员普通请求绕过审计的后门。

## 15. 主要风险与控制

- 遗漏新上游 Mutation 会形成旁路；建立 Router 注册测试和代码扫描。
- 过早 enforced 会导致空目录；每个资源需先发布至少一个可用对象。

## 16. 模块移交物

- 受管策略、Guard、中间件覆盖、用户 UI 收口、observe-only 仪表。
