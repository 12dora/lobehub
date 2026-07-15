# M00 · 企业扩展骨架与 Feature Flags

> 波次：W1  
> 估算：1–1.5 人周  
> 前置依赖：无  
> 源码基线：LobeHub 2.2.10（设计基线提交 4bab1636408e60a7ee17b640490fbf33a310a325）

## 1. 交付目标

- 建立与上游业务代码隔离的企业扩展目录、类型边界和挂载点。
- 提供统一的服务端能力快照、Feature Flag、错误码和模块注册机制。
- 保证所有新能力在 Flag 关闭时不改变当前 LobeHub 行为。

## 2. 范围

- 新增企业 Client、Server、Types、Const 目录。
- 定义平台能力 `PlatformCapabilities` 和受管资源枚举。
- 接入桌面路由、全局 Provider、tRPC 根路由和服务器配置的最小挂载点。
- 建立补丁台账、目录约束和 CI 路径检查。

## 3. 明确非范围

- 不实现具体 RBAC、用户管理或业务资源 CRUD。
- 不重命名现有包和内部标识。
- 不在此模块引入新的 UI 设计系统。

## 4. 当前源码落点

- `src/business/client/BusinessDesktopRoutes.tsx`：桌面业务路由扩展点。
- `src/business/client/BusinessGlobalProvider.tsx`：全局 Provider 扩展点。
- `apps/server/src/routers/lambda/index.ts`：tRPC Lambda 根路由。
- `apps/server/src/featureFlags/index.ts`：已有 RuntimeConfig Feature Flag 模式。
- `tsconfig.json`：`@/server/*`、`@/*`、数据库等路径映射。

## 5. 建议新增目录/文件

- `src/enterprise/client/routes/`、`features/`、`providers/`、`services/`。
- `apps/server/src/enterprise/routers/`、`services/`、`repositories/`、`guards/`。
- `packages/types/src/platform/` 与 `packages/const/src/platform/`。
- `docs/enterprise-patches/` 或仓库根 `enterprise-patches.md`。

## 6. 目标设计

- 客户端只消费服务端返回的公开能力，不从 `NEXT_PUBLIC_*` 推断授权。
- 能力快照至少包含 `adminAccess`、公开的管理资源开关、设置策略 Revision、Branding Revision；普通用户不接收管理员权限细节。
- 所有 Flag 默认关闭；生产启用顺序由 M15 控制。
- 模块通过注册器暴露路由、菜单、后台系统检查项，避免在多个核心文件重复插入条件分支。

## 7. 数据模型与持久化

- 本模块不建业务表；可先定义 `platform_config_revision` 的类型契约，实际表由 M01 创建。

## 8. 服务端 API / Contract

- `platform.getCapabilities`：当前用户的公开平台能力。
- `platform.getPublicSnapshot`：匿名或已登录可读取的 Branding/登录公开快照。
- 错误码前缀统一为 `PLATFORM_*`、`ADMIN_*`、`MANAGED_*`。

## 9. 管理端与用户端 UI

- 新增 `EnterprisePlatformProvider`，初始化能力快照并提供 Suspense/ErrorBoundary。
- 客户端路由只根据能力决定是否加载页面；服务端仍做最终授权。
- 全局错误映射支持权限不足、Revision 冲突、资源受管、需要重启等状态。

## 10. 运行时接入

- Flag 关闭时根路由和 Provider 返回与当前版本一致。
- `configRevision` 作为后续缓存失效的公共字段，不在客户端携带 Secret 或完整策略。

## 11. 分 PR 实施步骤

1. PR-001：新增目录、公共类型、枚举、错误码和单元测试。
2. PR-002：新增服务端 Feature Flag 解析与能力快照，只读接入。
3. PR-003：接入 `BusinessGlobalProvider`、`BusinessDesktopRoutesWithoutMainLayout` 和 tRPC 根路由；Flag 默认关闭。
4. PR-004：增加补丁台账、路径边界 CI 和模块模板。

## 12. 测试清单

- Flag 关闭回归：构建产物、路由树、Global Config Snapshot 不变化。
- 能力快照不泄露角色列表、Secret、内部配置值。
- Web 与 Electron 路由同步测试继续通过。

## 13. 上线与回滚

- 只先部署代码，不启用任何业务 Flag。
- 发现兼容问题时可单独关闭 `ENABLE_ENTERPRISE_ADMIN`，无需回滚数据库。

## 14. Definition of Done

- 企业目录可独立编译，依赖方向不从通用包反向 import Client。
- 四个稳定挂载点完成且有测试。
- Feature Flag 全部默认关闭，关闭后用户行为无变化。

## 15. 主要风险与控制

- 新增包过多会增加构建成本；首版只建立必要目录，不为了“分层漂亮”创建空包。
- 直接修改 `src/business` 可能与上游商业版扩展冲突；企业实现应放 `src/enterprise`，业务扩展文件只保留一行注册。

## 16. 模块移交物

- 目录骨架、能力类型、Flag 清单、错误码清单、补丁台账模板、CI 约束。
