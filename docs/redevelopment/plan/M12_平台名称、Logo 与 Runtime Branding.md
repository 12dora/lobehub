# M12 · 平台名称、Logo 与 Runtime Branding

> 波次：W7  
> 估算：2–3 人周  
> 前置依赖：M00、M03、M05  
> 源码基线：LobeHub 2.2.10（设计基线提交 4bab1636408e60a7ee17b640490fbf33a310a325）

> 决策（2026-07-16）：正式平台名称为 **AIHub**；桌面安装包名称/图标**纳入首版**（独立构建与签名流水线，不与 Web 运行时切换捆绑）。

## 1. 交付目标

- 允许管理员配置 AIHub 平台名称、Logo、链接、邮件显示和用户可见文案（默认值即 AIHub）。
- 替换用户可见的 LobeHub 提及，同时保护内部标识和许可证。
- 实现运行时 Branding 与需要重启/重构建项的清晰边界。
- 交付 AIHub 名称/图标的桌面安装包（Electron）独立构建与签名流水线。

## 2. 范围

- Branding 数据模型、公共快照、React Provider、服务端 Metadata/Manifest/邮件接入、字面量扫描。
- 默认 Agent 显示名与平台名称联动。
- 支持 Logo/Favicon/PWA 资源的受控上传或 URL。
- 桌面安装包名称、图标与签名的独立构建流水线；相关字段在后台标记 `rebuild_required`，发布 Web 运行时 Branding 不触发桌面构建。

## 3. 明确非范围

- 不修改 npm 包名、内部 Provider ID、数据库表名、协议 Header、源码许可证和法定归属。
- 不盲目全仓替换字符串 `LobeHub`。

## 4. 当前源码落点

- `packages/business/const/src/branding.ts`：当前编译期 Branding 常量及许可提示。
- `src/business/client/BusinessGlobalProvider.tsx`。
- `src/server/metadata.ts`、`src/server/manifest.ts`、AuthShell、邮件模板、locales。
- 默认 Agent 的 Lobe AI 显示名与头像常量。

## 5. 建议新增目录/文件

- `packages/database/src/schemas/platform/branding.ts`。
- `apps/server/src/enterprise/services/branding/`。
- `src/enterprise/client/providers/RuntimeBrandingProvider.tsx`。
- `src/enterprise/client/routes/admin/branding/`。
- `scripts/enterprise/scan-branding-literals.ts`。

## 6. 目标设计

- 公开 Branding Snapshot 不含 Secret，可匿名缓存；字段包括 name、shortName、logo、favicon、support/privacy/terms、email display。
- `BRANDING_NAME` 保留为无数据库/启动失败时默认回退，不再作为所有 UI 的唯一来源。
- i18n 文案使用 `{{platformName}}` 插值；内部技术文档和许可证通过 allowlist 排除。
- Manifest/Metadata 中可运行时生成的项实时读取 Snapshot；静态打包图标或桌面应用名标为 `restart_required` / `rebuild_required`。
- 默认 Inbox 显示名可使用显式配置，未配置时为 `${platformName} AI`。

## 7. 数据模型与持久化

- `platform_branding`：draft/published 字段、asset refs、revision。
- 图片元数据可引用对象存储，不把大文件放 JSONB。

## 8. 服务端 API / Contract

- `admin.branding.getDraft/saveDraft/validate/publish/rollback/uploadAsset`。
- `platform.getPublicSnapshot` 返回 Published Branding。

## 9. 管理端与用户端 UI

- 实时预览登录页、桌面导航、页面标题、邮件头部和默认 Agent 卡片。
- 字段旁标记 `即时生效`、`需重启`、`需重新构建桌面包`。
- 链接字段有协议和域名校验。

## 10. 运行时接入

- 客户端 Provider 在 SPA 初始化时加载，Revision 变化后刷新。
- 服务端 Metadata/Manifest 读取缓存 Snapshot；读取失败回退常量。
- 邮件发送时使用当时 Published Snapshot，审计记录 Revision。

## 11. 分 PR 实施步骤

1. PR-058：Schema、Public Snapshot、Provider 和 fallback。
2. PR-059：核心导航/Auth/Metadata/Manifest/邮件接入。
3. PR-060：Admin 编辑/预览/发布和资产上传。
4. PR-061：i18n 插值、字面量扫描、Screenshot 回归。
5. PR-062：默认 Inbox 显示名联动。
6. PR-063：桌面安装包 Branding（electron-builder 产品名/图标/BundleId 评估、图标资产、构建与签名流水线）。

## 12. 测试清单

- 登录页、导航、Title、Manifest、邮件、支持链接和默认 Agent 显示一致。
- Flag 关闭或 DB 不可用时回退 LobeHub 默认。
- 扫描未误改包名、协议 ID、数据库标识、许可证。
- 恶意 SVG/URL 无法形成 XSS。

## 13. 上线与回滚

- 先发布名称/链接，再发布 Logo/Favicon。
- 桌面包 Branding 单独构建和签名，不与 Web 运行时切换捆绑。

## 14. Definition of Done

- AIHub 名称可后台发布和回滚。
- 所有用户可见核心入口一致。
- 桌面安装包以 AIHub 名称/图标产出并完成签名，安装、更新通道验证通过。
- 内部稳定标识和许可证保持原样。

## 15. 主要风险与控制

- 存在大量硬编码；用扫描 allowlist 持续治理，而不是一次性替换。
- 缓存可能导致名称短时不一致；以 Branding Revision 和明确 TTL 控制。

## 16. 模块移交物

- Branding Schema/Provider/Admin UI、核心接入点、扫描脚本、截图测试、资产策略。
