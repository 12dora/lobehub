# M03 · 管理后台壳、独立 URL、路由与通用 UI

> 波次：W2  
> 估算：2–3 人周  
> 前置依赖：M00、M02（只读能力）  
> 源码基线：LobeHub 2.2.10（设计基线提交 4bab1636408e60a7ee17b640490fbf33a310a325）

## 1. 交付目标

- 提供 `/admin` 独立入口、统一布局、权限驱动导航和通用管理交互。
- 采用 LobeHub 原生组件、主题、响应式和错误处理方式。
- 为后续模块提供可复用列表、详情、发布、审计和 Secret 表单组件。

## 2. 范围

- 桌面 Web 和 Electron 路由同步。
- Admin Layout、SideNav、Header、Breadcrumb、权限边界、404/403/500。
- 通用 DataTable、FilterBar、StatusBadge、RevisionBanner、DangerConfirm。

## 3. 明确非范围

- 首版不提供完整移动端管理后台。
- 不复制普通用户设置页作为独立长期分叉。
- 不在 Client 保存服务端返回的敏感配置。

## 4. 当前源码落点

- `src/business/client/BusinessDesktopRoutes.tsx`：推荐挂载 `BusinessDesktopRoutesWithoutMainLayout`。
- `src/spa/router/desktopRouter.config.tsx` 与 `.desktop.tsx`：两套路由。
- `src/routes/(main)/settings/...`：可抽取的原生设置 UI。
- `@lobehub/ui/base-ui`、`@lobehub/ui`、`antd-style`：现有 UI 栈。

## 5. 建议新增目录/文件

- `src/enterprise/client/routes/admin/_layout/`。
- `src/enterprise/client/routes/admin/{overview,users,settings,ai,skills,connectors,agents,identity,branding,audit,system}/`。
- `src/enterprise/client/features/admin/`：通用组件。
- `src/enterprise/client/providers/AdminAccessProvider.tsx`。

## 6. 目标设计

- 路由守卫先检查登录，再请求 `admin.auth.getMyAccess`；无权限不加载敏感页面 Bundle 的数据请求。
- 菜单项声明 `requiredPermissions`，同一声明用于导航和路由元数据。
- 页面默认使用三段式：列表/导航、内容、详情抽屉或编辑页；发布型资源显示 Draft 与 Published 对比。
- 所有写操作显示明确结果、冲突、重试和审计原因。

## 7. 数据模型与持久化

- 无新增业务表。

## 8. 服务端 API / Contract

- 只读依赖 `admin.auth.getMyAccess`、`platform.getCapabilities`。
- 通用 Hook 处理 `PLATFORM_REVISION_CONFLICT`、`ADMIN_REAUTH_REQUIRED`、`RESOURCE_MANAGED_BY_PLATFORM`。

## 9. 管理端与用户端 UI

- 路由建议：`/admin`、`/admin/users`、`/admin/settings`、`/admin/ai/providers`、`/admin/ai/models`、`/admin/skills`、`/admin/connectors`、`/admin/agents`、`/admin/identity/providers`、`/admin/branding`、`/admin/audit`、`/admin/system`。
- 复用 Provider/Model/Skill/Connector 的展示组件前，先抽离领域 Feature 和数据 Adapter，禁止 admin 页面直接 import 普通用户 route 页面。
- Secret 输入统一采用“未修改/替换”状态，不以掩码字符串回传原值。

## 10. 运行时接入

- 管理员入口可以由用户菜单显示；直接访问 URL 仍是主要入口。
- 桌面端和 Web 路由路径完全一致；移动访问显示“不支持移动管理”的明确页面。

## 11. 分 PR 实施步骤

1. PR-014：Admin 路由树、Layout、Access Provider、403/404。
2. PR-015：导航、Breadcrumb、权限裁剪和路由同步测试。
3. PR-016：通用表格/筛选/状态/发布/危险确认组件。
4. PR-017：从普通设置页抽取首批可复用展示组件，并保留兼容 Adapter。

## 12. 测试清单

- 匿名深链跳登录，普通用户深链返回 403，不发起业务数据请求。
- 浅色/深色、中文/英文、窄屏、键盘导航、加载/空/错误/冲突状态。
- Web/Electron 路由同步测试。
- 组件可访问性：焦点、Label、Dialog 关闭和危险确认。

## 13. 上线与回滚

- 先上线空壳和只读 Overview；Flag 关闭时不注册 `/admin`。
- 布局异常可关闭 Admin Flag，不影响普通用户路由。

## 14. Definition of Done

- 独立 URL 可刷新、可深链、无权限不泄漏数据。
- UI 未引入第二套 Design System。
- 后续页面可在不修改 Layout 的情况下注册。

## 15. 主要风险与控制

- 直接复用 route 页面会形成循环依赖和交互语义错位；必须抽 Feature。
- 权限菜单与 API 权限漂移；使用同一常量源并做静态/测试校验。

## 16. 模块移交物

- Admin Shell、路由表、组件库、页面模板、路由权限测试。
